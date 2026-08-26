import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';

/**
 * Per-user API keys, so PerguntAI's agent, guardrails and warehouse tooling can
 * be driven programmatically.
 *
 * The security model is deliberately "a key is its owner": a key carries no
 * permissions of its own. Every request authenticated by one resolves the
 * owner's live entry in access.json — role, model allowlist, sqlWrite, blocked
 * — exactly as an interactive session does, and warehouse queries run under the
 * owner's own StarRocks identity. Blocking or demoting a user in the admin
 * panel therefore disables their keys on the next request, with nothing to
 * revoke separately.
 *
 * Only a SHA-256 of each key is stored, so the file is not itself a credential
 * and a leaked backup cannot be replayed. The plaintext exists once, in the
 * response that creates it.
 */

const PREFIX = 'pai_';

export type ApiKeyScope = 'chat' | 'full';

export interface ApiKeyRecord {
	id: string;
	label: string;
	/** sha256(key), hex. The key itself is never stored. */
	hash: string;
	/** Non-secret display hint (prefix…last4) so owners can match keys to scripts. */
	hint?: string;
	/** 'chat' = data plane only (/v1 + /api/chat + /api/models); 'full' = acts fully as the owner. */
	scope?: ApiKeyScope;
	createdAt: string;
	lastUsedAt: string | null;
	/** ISO date, or null for a key that does not expire. */
	expiresAt: string | null;
	revokedAt: string | null;
}

/** Shape safe to show the owner — no hash, no key. */
export interface PublicApiKey {
	id: string;
	label: string;
	hint?: string;
	scope: ApiKeyScope;
	createdAt: string;
	lastUsedAt: string | null;
	expiresAt: string | null;
}

function pathFor(username: string): string {
	const safe = username.toLowerCase().replace(/[^a-z0-9._-]/g, '_');
	return join(env.DATA_DIR ?? 'data', 'apikeys', `${safe}.json`);
}

function hash(key: string): string {
	return createHash('sha256').update(key).digest('hex');
}

async function read(username: string): Promise<ApiKeyRecord[]> {
	try {
		return JSON.parse(await readFile(pathFor(username), 'utf8')) as ApiKeyRecord[];
	} catch {
		return [];
	}
}

async function write(username: string, keys: ApiKeyRecord[]): Promise<void> {
	const file = pathFor(username);
	await mkdir(join(file, '..'), { recursive: true });
	await writeFile(file, JSON.stringify(keys, null, 2), 'utf8');
}

export function publicView(key: ApiKeyRecord): PublicApiKey {
	return {
		id: key.id,
		label: key.label,
		...(key.hint ? { hint: key.hint } : {}),
		// Legacy keys (pre-scopes) keep behaving as they always did: full.
		scope: key.scope ?? 'full',
		createdAt: key.createdAt,
		lastUsedAt: key.lastUsedAt,
		expiresAt: key.expiresAt
	};
}

export async function listKeys(username: string): Promise<PublicApiKey[]> {
	return (await read(username)).filter((k) => !k.revokedAt).map(publicView);
}

/** Returns the plaintext key ONCE — it cannot be recovered afterwards. */
export async function createKey(
	username: string,
	label: string,
	expiresInDays?: number,
	scope: ApiKeyScope = 'chat'
): Promise<{ key: string; record: PublicApiKey }> {
	const key = PREFIX + randomBytes(32).toString('base64url');
	const record: ApiKeyRecord = {
		id: randomUUID(),
		label: label.trim().slice(0, 80) || 'API key',
		hash: hash(key),
		hint: `${key.slice(0, 7)}…${key.slice(-4)}`,
		scope,
		createdAt: new Date().toISOString(),
		lastUsedAt: null,
		expiresAt:
			expiresInDays && expiresInDays > 0
				? new Date(Date.now() + expiresInDays * 86_400_000).toISOString()
				: null,
		revokedAt: null
	};

	const keys = await read(username);
	keys.push(record);
	await write(username, keys);

	return { key, record: publicView(record) };
}

export async function revokeKey(username: string, id: string): Promise<boolean> {
	const keys = await read(username);
	const target = keys.find((k) => k.id === id && !k.revokedAt);
	if (!target) return false;
	target.revokedAt = new Date().toISOString();
	await write(username, keys);
	return true;
}

export function looksLikeApiKey(value: string): boolean {
	return value.startsWith(PREFIX);
}

/**
 * Resolves a raw key to its owner, or null.
 *
 * Keys are stored per user, so finding the owner means scanning the store —
 * the directory is small (one file per user who has ever made a key) and this
 * only runs for requests that actually present a key.
 */
export async function resolveKeyOwner(
	rawKey: string
): Promise<{ username: string; keyId: string; keyLabel: string; scope: ApiKeyScope } | null> {
	if (!looksLikeApiKey(rawKey)) return null;

	const dir = join(env.DATA_DIR ?? 'data', 'apikeys');
	let files: string[];
	try {
		const { readdir } = await import('node:fs/promises');
		files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
	} catch {
		return null;
	}

	const wanted = Buffer.from(hash(rawKey), 'hex');
	const now = Date.now();

	for (const file of files) {
		const username = file.replace(/\.json$/, '');
		const keys = await read(username);
		for (const key of keys) {
			if (key.revokedAt) continue;
			if (key.expiresAt && Date.parse(key.expiresAt) < now) continue;

			const stored = Buffer.from(key.hash, 'hex');
			if (stored.length !== wanted.length || !timingSafeEqual(stored, wanted)) continue;

			// Best-effort usage stamp; a failed write must not fail the request.
			key.lastUsedAt = new Date().toISOString();
			void write(username, keys).catch(() => {});
			return { username, keyId: key.id, keyLabel: key.label, scope: key.scope ?? 'full' };
		}
	}
	return null;
}

/** Every user's keys (revoked included), for the admin security view. */
export async function listAllKeys(): Promise<
	{ username: string; keys: (PublicApiKey & { revokedAt: string | null })[] }[]
> {
	const dir = join(env.DATA_DIR ?? 'data', 'apikeys');
	let files: string[];
	try {
		const { readdir } = await import('node:fs/promises');
		files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
	} catch {
		return [];
	}
	const out = [];
	for (const file of files) {
		const username = file.replace(/\.json$/, '');
		const keys = (await read(username)).map((k) => ({
			...publicView(k),
			revokedAt: k.revokedAt
		}));
		if (keys.length) out.push({ username, keys });
	}
	return out.sort((a, b) => a.username.localeCompare(b.username));
}

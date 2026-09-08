import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { env } from '$env/dynamic/private';

/**
 * Sessions revoked by OIDC back-channel logout, by the IdP's `sub` and/or
 * `sid`. The bearer JWEs are stateless, so revocation cannot invalidate them
 * cryptographically — instead authenticateRequest refuses any session whose
 * captured sub/sid appears here, the same live-check pattern as access.json.
 *
 * Entries outlive the longest possible session (MAX_SESSION_MS in ./auth):
 * after that no JWE minted before the revocation can still verify, so the
 * entry has nothing left to block and is pruned.
 */

const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface Entry {
	sub?: string;
	sid?: string;
	at: number;
}

function storePath(): string {
	return join(env.DATA_DIR ?? 'data', 'logout-denylist.json');
}

let cache: Entry[] | null = null;
let queue: Promise<void> = Promise.resolve();

async function load(): Promise<Entry[]> {
	if (cache) return cache;
	try {
		const raw = JSON.parse(await readFile(storePath(), 'utf8')) as { entries?: Entry[] };
		cache = Array.isArray(raw.entries) ? raw.entries : [];
	} catch {
		cache = [];
	}
	return cache;
}

function prune(entries: Entry[]): Entry[] {
	const cutoff = Date.now() - ENTRY_TTL_MS;
	return entries.filter((e) => e.at > cutoff);
}

export async function revokeSessions(ref: { sub?: string; sid?: string }): Promise<void> {
	if (!ref.sub && !ref.sid) return;
	const entries = prune(await load());
	entries.push({ ...(ref.sub ? { sub: ref.sub } : {}), ...(ref.sid ? { sid: ref.sid } : {}), at: Date.now() });
	cache = entries;
	queue = queue
		.then(async () => {
			await mkdir(dirname(storePath()), { recursive: true });
			await writeFile(storePath(), JSON.stringify({ entries }, null, '\t'));
		})
		.catch((e) => console.warn('logout denylist write failed:', e));
	await queue;
}

/** True when the session's captured OIDC identifiers were revoked. */
export async function isSessionRevoked(sub?: string, sid?: string): Promise<boolean> {
	if (!sub && !sid) return false;
	const entries = prune(await load());
	return entries.some((e) => (e.sid && e.sid === sid) || (e.sub && e.sub === sub));
}

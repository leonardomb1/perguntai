import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { decrypt, encrypt } from './oidcStore';

/**
 * Embed keys: per-portal access to the anonymous embed surface, minted by an
 * admin in the console. Each key maps SERVER-SIDE to its own StarRocks service
 * account (encrypted at rest, same crypto as the credential/OIDC stores) plus
 * its own limits and framing origins — so the warehouse credential never
 * appears in any embedding page. A key visible in a portal's HTML only grants
 * access to the guarded embed surface (read-only, capped, audited) and can be
 * revoked individually.
 *
 * One admin-owned file at DATA_DIR/embed-keys.json — keys are deployment
 * infrastructure, not user data.
 */

const PREFIX = 'emb_';

export interface EmbedKeyRecord {
	id: string;
	label: string;
	/** SHA-256 of the full key — the key itself is shown once at mint time. */
	hash: string;
	/** Non-secret display hint (prefix…last4). */
	hint: string;
	starrocksUser: string;
	/** AES-256-GCM blob (JWT_SECRET-derived key). */
	starrocksPasswordEnc: string;
	/** Per-key overrides — fall back to the deployment defaults when absent. */
	maxMessages?: number;
	dailyTokens?: number;
	/** CSP frame-ancestors for pages loaded with this key. */
	allowedOrigins?: string;
	createdAt: string;
	createdBy: string;
	revoked?: boolean;
}

/** Shape safe for the console — no hash, no credential. */
export interface PublicEmbedKey {
	id: string;
	label: string;
	hint: string;
	starrocksUser: string;
	maxMessages?: number;
	dailyTokens?: number;
	allowedOrigins?: string;
	createdAt: string;
	createdBy: string;
	revoked?: boolean;
}

function storePath(): string {
	return join(env.DATA_DIR ?? 'data', 'embed-keys.json');
}

function hashKey(key: string): string {
	return createHash('sha256').update(key).digest('hex');
}

async function readAll(): Promise<EmbedKeyRecord[]> {
	try {
		const parsed = JSON.parse(await readFile(storePath(), 'utf8'));
		return Array.isArray(parsed?.keys) ? (parsed.keys as EmbedKeyRecord[]) : [];
	} catch {
		return [];
	}
}

async function writeAll(keys: EmbedKeyRecord[]): Promise<void> {
	const path = storePath();
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, JSON.stringify({ keys }));
}

export function publicEmbedKey(key: EmbedKeyRecord): PublicEmbedKey {
	return {
		id: key.id,
		label: key.label,
		hint: key.hint,
		starrocksUser: key.starrocksUser,
		...(key.maxMessages ? { maxMessages: key.maxMessages } : {}),
		...(key.dailyTokens ? { dailyTokens: key.dailyTokens } : {}),
		...(key.allowedOrigins ? { allowedOrigins: key.allowedOrigins } : {}),
		createdAt: key.createdAt,
		createdBy: key.createdBy,
		...(key.revoked ? { revoked: true } : {})
	};
}

export async function listEmbedKeys(): Promise<PublicEmbedKey[]> {
	return (await readAll()).map(publicEmbedKey);
}

export async function createEmbedKey(input: {
	label: string;
	starrocksUser: string;
	starrocksPassword: string;
	maxMessages?: number;
	dailyTokens?: number;
	allowedOrigins?: string;
	createdBy: string;
}): Promise<{ key: string; record: PublicEmbedKey }> {
	const key = PREFIX + randomBytes(32).toString('base64url');
	const record: EmbedKeyRecord = {
		id: randomUUID(),
		label: input.label.trim().slice(0, 60) || 'embed',
		hash: hashKey(key),
		hint: `${key.slice(0, 7)}…${key.slice(-4)}`,
		starrocksUser: input.starrocksUser.trim(),
		starrocksPasswordEnc: encrypt(input.starrocksPassword),
		...(input.maxMessages && input.maxMessages > 0 ? { maxMessages: Math.floor(input.maxMessages) } : {}),
		...(input.dailyTokens && input.dailyTokens > 0 ? { dailyTokens: Math.floor(input.dailyTokens) } : {}),
		...(input.allowedOrigins?.trim() ? { allowedOrigins: input.allowedOrigins.trim() } : {}),
		createdAt: new Date().toISOString(),
		createdBy: input.createdBy
	};
	const keys = await readAll();
	keys.push(record);
	await writeAll(keys);
	return { key, record: publicEmbedKey(record) };
}

export async function revokeEmbedKey(id: string): Promise<boolean> {
	const keys = await readAll();
	const record = keys.find((k) => k.id === id);
	if (!record || record.revoked) return false;
	record.revoked = true;
	await writeAll(keys);
	return true;
}

export function looksLikeEmbedKey(value: string): boolean {
	return value.startsWith(PREFIX) && value.length > PREFIX.length + 20;
}

/** The resolved access an embed key grants — null for unknown/revoked keys. */
export interface EmbedKeyAccess {
	id: string;
	label: string;
	credentials: { username: string; password: string };
	maxMessages?: number;
	dailyTokens?: number;
	allowedOrigins?: string;
}

export async function verifyEmbedKey(rawKey: string): Promise<EmbedKeyAccess | null> {
	if (!looksLikeEmbedKey(rawKey)) return null;
	const wanted = Buffer.from(hashKey(rawKey), 'hex');
	for (const record of await readAll()) {
		const stored = Buffer.from(record.hash, 'hex');
		if (stored.length === wanted.length && timingSafeEqual(stored, wanted)) {
			if (record.revoked) return null;
			const password = decrypt(record.starrocksPasswordEnc);
			if (!password) return null; // rotated JWT_SECRET — key must be re-minted
			return {
				id: record.id,
				label: record.label,
				credentials: { username: record.starrocksUser, password },
				...(record.maxMessages ? { maxMessages: record.maxMessages } : {}),
				...(record.dailyTokens ? { dailyTokens: record.dailyTokens } : {}),
				...(record.allowedOrigins ? { allowedOrigins: record.allowedOrigins } : {})
			};
		}
	}
	return null;
}

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { refresh, type TokenSet } from './oidc';

/**
 * The user's OIDC refresh token, one encrypted JSON file per user under
 * DATA_DIR/oidc — same shape and crypto as the settings store.
 *
 * Why this exists at all: the id_token is PerguntAI's StarRocks credential
 * (the FE is configured for `authentication_jwt`), but authentik's tokens live
 * about five minutes while a session lives 24h and scheduled flows run days
 * later. Holding the long-lived refresh token server-side lets any code path
 * mint a fresh id_token on demand, and keeps it out of the browser entirely —
 * the bearer session never carries a warehouse credential.
 */

function key(): Buffer {
	const value = env.JWT_SECRET;
	if (!value) throw new Error('JWT_SECRET is not set');
	return createHash('sha256').update(value).digest();
}

export function encrypt(plain: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key(), iv);
	const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decrypt(blob: string): string | null {
	try {
		const raw = Buffer.from(blob, 'base64');
		const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
		decipher.setAuthTag(raw.subarray(12, 28));
		return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
	} catch {
		// Wrong JWT_SECRET or corrupt file — treat as absent, which forces a
		// fresh sign-in rather than erroring in the middle of a query.
		return null;
	}
}

function pathFor(username: string): string {
	const safe = username.toLowerCase().replace(/[^a-z0-9._-]/g, '_');
	return join(env.DATA_DIR ?? 'data', 'oidc', `${safe}.json`);
}

interface StoredTokens {
	refreshToken: string;
	/** Cached id_token, reused until it is close to expiry. */
	idToken?: string;
	expiresAt?: number;
	updatedAt: string;
}

async function read(username: string): Promise<StoredTokens | null> {
	try {
		const raw = await readFile(pathFor(username), 'utf8');
		const file = JSON.parse(raw) as { blob?: string };
		if (!file.blob) return null;
		const plain = decrypt(file.blob);
		return plain ? (JSON.parse(plain) as StoredTokens) : null;
	} catch {
		return null;
	}
}

async function write(username: string, tokens: StoredTokens): Promise<void> {
	const file = pathFor(username);
	await mkdir(join(file, '..'), { recursive: true });
	await writeFile(file, JSON.stringify({ blob: encrypt(JSON.stringify(tokens)) }), 'utf8');
}

/** Persists what the token endpoint returned. Called on login and after each refresh. */
export async function saveTokens(username: string, tokens: TokenSet): Promise<void> {
	// A refresh response may omit refresh_token when the provider is not
	// rotating them — keep the existing one rather than losing the ability to
	// refresh at all.
	const previous = await read(username);
	const refreshToken = tokens.refreshToken ?? previous?.refreshToken;
	if (!refreshToken) return;

	await write(username, {
		refreshToken,
		idToken: tokens.idToken,
		expiresAt: tokens.expiresAt,
		updatedAt: new Date().toISOString()
	});
}

/**
 * A currently-valid id_token for this user, refreshing if the cached one is
 * spent. Null when the user has no stored refresh token (never signed in since
 * OIDC, or signed out) or the refresh was rejected — callers should treat that
 * as "needs to sign in again" rather than a server error.
 */
export async function currentIdToken(username: string): Promise<string | null> {
	const stored = await read(username);
	if (!stored) return null;

	if (stored.idToken && stored.expiresAt && stored.expiresAt > Date.now()) {
		return stored.idToken;
	}

	try {
		const fresh = await refresh(stored.refreshToken);
		await saveTokens(username, fresh);
		return fresh.idToken;
	} catch (error) {
		// Expired/revoked refresh token (authentik keeps them 30 days) — drop it
		// so the next request sends the user to sign in instead of retrying.
		console.error(`oidc: refresh failed for ${username}`, error);
		await forgetTokens(username);
		return null;
	}
}

export async function forgetTokens(username: string): Promise<void> {
	try {
		await unlink(pathFor(username));
	} catch {
		// already gone
	}
}

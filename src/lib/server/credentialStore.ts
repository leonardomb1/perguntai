import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';
import { decrypt, encrypt } from './oidcStore';

/**
 * The warehouse credential for password (LDAP) users — the password-door
 * counterpart of oidcStore, one encrypted file per user under
 * DATA_DIR/warehouse.
 *
 * Why this exists: an interactive session carries the user's password inside
 * its encrypted JWE, but an API-key request carries nothing — and on an
 * LDAP-only deployment there is no refresh token to mint warehouse id_tokens
 * from, so `/v1` calls could never open a StarRocks connection. Persisting the
 * credential (AES-256-GCM at rest, JWT_SECRET-derived key, same crypto as the
 * OIDC and settings stores) lets API keys run queries as their owner.
 *
 * Saved on every successful password sign-in (so it tracks directory password
 * changes); deleted on sign-out, which revokes API-key warehouse access until
 * the next sign-in — mirroring how sign-out drops the OIDC refresh token.
 */

function pathFor(username: string): string {
	const safe = username.toLowerCase().replace(/[^a-z0-9._-]/g, '_');
	return join(env.DATA_DIR ?? 'data', 'warehouse', `${safe}.json`);
}

export async function saveWarehousePassword(username: string, password: string): Promise<void> {
	const file = pathFor(username);
	await mkdir(join(file, '..'), { recursive: true });
	await writeFile(
		file,
		JSON.stringify({ blob: encrypt(JSON.stringify({ password, updatedAt: new Date().toISOString() })) }),
		'utf8'
	);
}

export async function storedWarehousePassword(username: string): Promise<string | null> {
	try {
		const raw = await readFile(pathFor(username), 'utf8');
		const file = JSON.parse(raw) as { blob?: string };
		if (!file.blob) return null;
		const plain = decrypt(file.blob);
		return plain ? ((JSON.parse(plain) as { password?: string }).password ?? null) : null;
	} catch {
		return null;
	}
}

export async function forgetWarehousePassword(username: string): Promise<void> {
	await unlink(pathFor(username)).catch(() => {});
}

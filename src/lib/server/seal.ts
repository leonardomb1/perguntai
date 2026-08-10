import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

/**
 * Credential sealing for flow deployments (owner's StarRocks login, encrypted
 * at rest so scheduled runs can act as the owner). Same AES-256-GCM scheme as
 * the settings store, distinct key derivation — salvaged from the old builder.
 */

function credKey(): Buffer {
	const value = env.JWT_SECRET;
	if (!value) throw new Error('JWT_SECRET is not set');
	return createHash('sha256').update(`endpoint-creds:${value}`).digest();
}

export function seal(creds: { username: string; password: string }): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', credKey(), iv);
	const body = Buffer.concat([cipher.update(JSON.stringify(creds), 'utf8'), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function openCreds(blob: string): { username: string; password: string } | null {
	try {
		const raw = Buffer.from(blob, 'base64');
		const decipher = createDecipheriv('aes-256-gcm', credKey(), raw.subarray(0, 12));
		decipher.setAuthTag(raw.subarray(12, 28));
		const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
		const parsed = JSON.parse(json);
		return parsed?.username && parsed?.password ? parsed : null;
	} catch {
		return null;
	}
}

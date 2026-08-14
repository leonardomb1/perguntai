import { getToken } from '$lib/session';

/**
 * Client for /api/keys. The plaintext key exists only in the POST response —
 * the server stores just a hash — so the caller MUST show it once and never
 * expects to read it back from `list()`.
 */

export interface PublicApiKey {
	id: string;
	label: string;
	createdAt: string;
	lastUsedAt: string | null;
	expiresAt: string | null;
}

function headers(): Record<string, string> {
	return { Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': 'application/json' };
}

export async function listKeys(): Promise<PublicApiKey[] | null> {
	try {
		const res = await fetch('/api/keys', { headers: headers() });
		if (!res.ok) return null;
		return (await res.json()).keys ?? [];
	} catch {
		return null;
	}
}

/** On success the `key` field is the ONLY time the plaintext is available. */
export async function createKey(
	label: string,
	expiresInDays?: number
): Promise<{ ok: true; key: string; record: PublicApiKey } | { ok: false; error: string }> {
	try {
		const res = await fetch('/api/keys', {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify({ label, ...(expiresInDays ? { expiresInDays } : {}) })
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
		return { ok: true, key: data.key, record: data.record };
	} catch {
		return { ok: false, error: 'network' };
	}
}

export async function revokeKey(id: string): Promise<boolean> {
	try {
		const res = await fetch(`/api/keys/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			headers: headers()
		});
		return res.ok;
	} catch {
		return false;
	}
}

/** True once the expiry has passed — such a key is dead but still listed. */
export function isExpired(key: PublicApiKey): boolean {
	return key.expiresAt !== null && Date.parse(key.expiresAt) < Date.now();
}

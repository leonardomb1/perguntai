import { store } from './store';

/**
 * Sessions revoked by OIDC back-channel logout, by the IdP's `sub` and/or
 * `sid`. The bearer JWEs are stateless, so revocation cannot invalidate them
 * cryptographically — instead authenticateRequest refuses any session whose
 * captured sub/sid appears here, the same live-check pattern as access.json.
 *
 * Replica-safe: the in-memory cache is trusted only briefly and re-validated
 * against the store's etag, so a revocation processed by one replica reaches
 * the others within CACHE_RECHECK_MS.
 *
 * Entries outlive the longest possible session (MAX_SESSION_MS in ./auth):
 * after that no JWE minted before the revocation can still verify, so the
 * entry has nothing left to block and is pruned.
 */

const KEY = 'logout-denylist.json';
const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_RECHECK_MS = 3000;

interface Entry {
	sub?: string;
	sid?: string;
	at: number;
}

let cache: { etag: string; entries: Entry[]; checkedAt: number } | null = null;
let queue: Promise<void> = Promise.resolve();

async function load(): Promise<Entry[]> {
	if (cache && Date.now() - cache.checkedAt < CACHE_RECHECK_MS) return cache.entries;
	const s = await store().stat(KEY).catch(() => null);
	if (!s) {
		cache = { etag: '', entries: [], checkedAt: Date.now() };
		return cache.entries;
	}
	if (cache && cache.etag === s.etag) {
		cache.checkedAt = Date.now();
		return cache.entries;
	}
	let entries: Entry[] = [];
	try {
		const raw = JSON.parse(await store().readText(KEY)) as { entries?: Entry[] };
		entries = Array.isArray(raw.entries) ? raw.entries : [];
	} catch {
		entries = [];
	}
	cache = { etag: s.etag, entries, checkedAt: Date.now() };
	return entries;
}

function prune(entries: Entry[]): Entry[] {
	const cutoff = Date.now() - ENTRY_TTL_MS;
	return entries.filter((e) => e.at > cutoff);
}

export async function revokeSessions(ref: { sub?: string; sid?: string }): Promise<void> {
	if (!ref.sub && !ref.sid) return;
	const entries = prune(await load());
	entries.push({ ...(ref.sub ? { sub: ref.sub } : {}), ...(ref.sid ? { sid: ref.sid } : {}), at: Date.now() });
	cache = null; // re-stat after the write lands
	queue = queue
		.then(() => store().write(KEY, JSON.stringify({ entries }, null, '\t')))
		.catch((e) => console.warn('logout denylist write failed:', e));
	await queue;
}

/** True when the session's captured OIDC identifiers were revoked. */
export async function isSessionRevoked(sub?: string, sid?: string): Promise<boolean> {
	if (!sub && !sid) return false;
	const entries = prune(await load());
	return entries.some((e) => (e.sid && e.sid === sid) || (e.sub && e.sub === sub));
}

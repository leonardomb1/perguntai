/**
 * Backend contract for the app data store (see ./index.ts). Semantics mirror
 * node:fs so the migration from DATA_DIR files was 1:1: reads THROW
 * StoreNotFoundError (code ENOENT) on a missing key, removes are idempotent,
 * writes create parents implicitly. Keys are relative, '/'-separated, and on
 * the local backend map to the exact pre-store file layout.
 */

export interface StoreStat {
	size: number;
	lastModified: Date;
	/** Changes whenever the content changes; format is backend-specific. */
	etag: string;
}

/** A held distributed lock; renew before ttl expires, release when done. */
export interface StoreLease {
	renew(): Promise<boolean>;
	release(): Promise<void>;
}

export interface StoreBackend {
	readonly name: string;

	/** Throws StoreNotFoundError when the key does not exist. */
	readText(key: string): Promise<string>;
	readBinary(key: string): Promise<Uint8Array>;

	write(key: string, data: string | Uint8Array): Promise<void>;
	/** Atomic-enough line append for logs (audit). */
	append(key: string, text: string): Promise<void>;

	/** Idempotent — a missing key is not an error. */
	remove(key: string): Promise<void>;
	removePrefix(prefix: string): Promise<void>;

	/** Full keys under the prefix. */
	list(prefix: string): Promise<string[]>;
	stat(key: string): Promise<StoreStat | null>;

	/** Single-runner lock; null when another holder is live. */
	acquireLease(key: string, ttlMs: number): Promise<StoreLease | null>;
}

export class StoreNotFoundError extends Error {
	readonly code = 'ENOENT';
	constructor(key: string) {
		super(`store: not found: ${key}`);
		this.name = 'StoreNotFoundError';
	}
}

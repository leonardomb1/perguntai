import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { StoreNotFoundError, type StoreBackend, type StoreLease, type StoreStat } from './types';

/**
 * Filesystem backend rooted at DATA_DIR — byte-compatible with the app's
 * pre-store file layout, so switching to the store changed no data on disk.
 * Safe for multiple replicas on ONE host sharing the volume; cross-host
 * needs the azure or s3 backend.
 */

function isNotFound(err: unknown): boolean {
	return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export class LocalStore implements StoreBackend {
	readonly name = 'local';
	private readonly root: string;

	constructor(root: string) {
		this.root = path.resolve(root);
	}

	private resolve(key: string): string {
		const full = path.resolve(this.root, key);
		const rel = path.relative(this.root, full);
		if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
			throw new Error(`store: key escapes root: ${key}`);
		}
		return full;
	}

	async readText(key: string): Promise<string> {
		try {
			return await fs.readFile(this.resolve(key), 'utf8');
		} catch (err) {
			if (isNotFound(err)) throw new StoreNotFoundError(key);
			throw err;
		}
	}

	async readBinary(key: string): Promise<Uint8Array> {
		try {
			return new Uint8Array(await fs.readFile(this.resolve(key)));
		} catch (err) {
			if (isNotFound(err)) throw new StoreNotFoundError(key);
			throw err;
		}
	}

	async write(key: string, data: string | Uint8Array): Promise<void> {
		const full = this.resolve(key);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, data);
	}

	async append(key: string, text: string): Promise<void> {
		const full = this.resolve(key);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.appendFile(full, text);
	}

	async remove(key: string): Promise<void> {
		try {
			await fs.unlink(this.resolve(key));
		} catch (err) {
			if (!isNotFound(err)) throw err;
		}
	}

	async removePrefix(prefix: string): Promise<void> {
		await fs.rm(this.resolve(prefix), { recursive: true, force: true });
	}

	async list(prefix: string): Promise<string[]> {
		const out: string[] = [];
		const walk = async (dir: string): Promise<void> => {
			let entries: import('node:fs').Dirent[];
			try {
				entries = await fs.readdir(dir, { withFileTypes: true });
			} catch (err) {
				if (isNotFound(err)) return;
				throw err;
			}
			for (const e of entries) {
				const abs = path.join(dir, e.name);
				if (e.isDirectory()) await walk(abs);
				else if (e.isFile()) {
					const key = path.relative(this.root, abs).split(path.sep).join('/');
					if (key.startsWith(prefix)) out.push(key);
				}
			}
		};
		await walk(path.dirname(this.resolve(prefix + '_')));
		return out;
	}

	async stat(key: string): Promise<StoreStat | null> {
		try {
			const s = await fs.stat(this.resolve(key));
			if (!s.isFile()) return null;
			return { size: s.size, lastModified: s.mtime, etag: `${s.mtimeMs}-${s.size}` };
		} catch (err) {
			if (isNotFound(err)) return null;
			throw err;
		}
	}

	/**
	 * Lockfile lease: created exclusively, stolen when expired. The steal has a
	 * small window on a shared volume, acceptable for the jobs this guards
	 * (a duplicated sweep converges; see scheduler.ts).
	 */
	async acquireLease(key: string, ttlMs: number): Promise<StoreLease | null> {
		const full = this.resolve(key);
		const owner = randomUUID();
		const body = () => JSON.stringify({ owner, expires: Date.now() + ttlMs });

		await fs.mkdir(path.dirname(full), { recursive: true });
		try {
			await fs.writeFile(full, body(), { flag: 'wx' });
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
			try {
				const cur = JSON.parse(await fs.readFile(full, 'utf8')) as { expires?: number };
				if (typeof cur.expires === 'number' && cur.expires > Date.now()) return null;
			} catch {
				// Corrupt lockfile counts as expired.
			}
			await fs.writeFile(full, body());
		}

		const stillOwner = async () => {
			try {
				return (JSON.parse(await fs.readFile(full, 'utf8')) as { owner?: string }).owner === owner;
			} catch {
				return false;
			}
		};
		return {
			renew: async () => {
				if (!(await stillOwner())) return false;
				await fs.writeFile(full, body());
				return true;
			},
			release: async () => {
				if (await stillOwner()) await fs.unlink(full).catch(() => {});
			}
		};
	}
}

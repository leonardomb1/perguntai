import { randomUUID } from 'node:crypto';
import { StoreNotFoundError, type StoreBackend, type StoreLease, type StoreStat } from './types';

/**
 * S3 backend (AWS or any S3-compatible endpoint). S3 has no native append or
 * lease, so both are built on conditional writes (If-Match / If-None-Match,
 * supported by S3 since late 2024): append is a read-concat-put retry loop
 * (fine for the low-volume audit log), and the lease is a lock object whose
 * takeover is guarded by the ETag. The SDK loads lazily.
 */

export interface S3Config {
	bucket: string;
	region?: string;
	endpoint?: string;
	accessKeyId: string;
	secretAccessKey: string;
	forcePathStyle?: boolean;
	prefix?: string;
}

type Sdk = typeof import('@aws-sdk/client-s3');
type S3Client = import('@aws-sdk/client-s3').S3Client;

interface LockBody {
	owner: string;
	expires: number;
}

export class S3Store implements StoreBackend {
	readonly name = 's3';
	private readonly cfg: S3Config;
	private readonly prefix: string;
	private clientP: Promise<{ sdk: Sdk; client: S3Client }> | null = null;

	constructor(cfg: S3Config) {
		this.cfg = cfg;
		this.prefix = cfg.prefix ? cfg.prefix.replace(/\/+$/, '') + '/' : '';
	}

	private client() {
		if (!this.clientP) {
			this.clientP = (async () => {
				const sdk = await import('@aws-sdk/client-s3');
				const client = new sdk.S3Client({
					region: this.cfg.region ?? 'auto',
					endpoint: this.cfg.endpoint,
					forcePathStyle: this.cfg.forcePathStyle,
					credentials: {
						accessKeyId: this.cfg.accessKeyId,
						secretAccessKey: this.cfg.secretAccessKey
					}
				});
				return { sdk, client };
			})();
			this.clientP.catch(() => (this.clientP = null));
		}
		return this.clientP;
	}

	private key(key: string): string {
		return this.prefix + key;
	}

	private isNotFound(err: unknown): boolean {
		const name = (err as { name?: string })?.name;
		return name === 'NoSuchKey' || name === 'NotFound';
	}

	private isPreconditionFailed(err: unknown): boolean {
		const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
		return status === 412 || status === 409;
	}

	async readBinary(key: string): Promise<Uint8Array> {
		const { sdk, client } = await this.client();
		try {
			const res = await client.send(
				new sdk.GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.key(key) })
			);
			return await res.Body!.transformToByteArray();
		} catch (err) {
			if (this.isNotFound(err)) throw new StoreNotFoundError(key);
			throw err;
		}
	}

	async readText(key: string): Promise<string> {
		return Buffer.from(await this.readBinary(key)).toString('utf8');
	}

	private async put(key: string, body: Buffer, cond?: { ifMatch?: string; ifNoneMatch?: string }) {
		const { sdk, client } = await this.client();
		await client.send(
			new sdk.PutObjectCommand({
				Bucket: this.cfg.bucket,
				Key: this.key(key),
				Body: body,
				IfMatch: cond?.ifMatch,
				IfNoneMatch: cond?.ifNoneMatch
			})
		);
	}

	async write(key: string, data: string | Uint8Array): Promise<void> {
		await this.put(key, typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data));
	}

	async append(key: string, text: string): Promise<void> {
		for (let attempt = 0; attempt < 6; attempt++) {
			const cur = await this.stat(key);
			try {
				if (!cur) {
					await this.put(key, Buffer.from(text, 'utf8'), { ifNoneMatch: '*' });
				} else {
					const existing = await this.readText(key);
					await this.put(key, Buffer.from(existing + text, 'utf8'), { ifMatch: cur.etag });
				}
				return;
			} catch (err) {
				if (!this.isPreconditionFailed(err)) throw err;
				await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
			}
		}
		throw new Error(`store(s3): append contention on ${key}`);
	}

	async remove(key: string): Promise<void> {
		const { sdk, client } = await this.client();
		await client.send(
			new sdk.DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: this.key(key) })
		);
	}

	async removePrefix(prefix: string): Promise<void> {
		for (const key of await this.list(prefix)) await this.remove(key);
	}

	async list(prefix: string): Promise<string[]> {
		const { sdk, client } = await this.client();
		const out: string[] = [];
		let token: string | undefined;
		do {
			const res = await client.send(
				new sdk.ListObjectsV2Command({
					Bucket: this.cfg.bucket,
					Prefix: this.key(prefix),
					ContinuationToken: token
				})
			);
			for (const obj of res.Contents ?? []) {
				if (obj.Key) out.push(this.prefix ? obj.Key.slice(this.prefix.length) : obj.Key);
			}
			token = res.IsTruncated ? res.NextContinuationToken : undefined;
		} while (token);
		return out;
	}

	async stat(key: string): Promise<StoreStat | null> {
		const { sdk, client } = await this.client();
		try {
			const res = await client.send(
				new sdk.HeadObjectCommand({ Bucket: this.cfg.bucket, Key: this.key(key) })
			);
			return {
				size: res.ContentLength ?? 0,
				lastModified: res.LastModified ?? new Date(0),
				etag: res.ETag ?? ''
			};
		} catch (err) {
			if (this.isNotFound(err)) return null;
			throw err;
		}
	}

	async acquireLease(key: string, ttlMs: number): Promise<StoreLease | null> {
		const owner = randomUUID();
		const body = () => Buffer.from(JSON.stringify({ owner, expires: Date.now() + ttlMs } satisfies LockBody));

		try {
			await this.put(key, body(), { ifNoneMatch: '*' });
		} catch (err) {
			if (!this.isPreconditionFailed(err)) throw err;
			// Held — steal only if expired, guarded by the ETag we read.
			const cur = await this.stat(key);
			if (!cur) return null;
			try {
				const lock = JSON.parse(await this.readText(key)) as LockBody;
				if (lock.expires > Date.now()) return null;
			} catch {
				// Corrupt lock counts as expired.
			}
			try {
				await this.put(key, body(), { ifMatch: cur.etag });
			} catch {
				return null;
			}
		}

		const stillOwner = async () => {
			try {
				return (JSON.parse(await this.readText(key)) as LockBody).owner === owner;
			} catch {
				return false;
			}
		};
		return {
			renew: async () => {
				if (!(await stillOwner())) return false;
				await this.write(key, body());
				return true;
			},
			release: async () => {
				if (await stillOwner()) await this.remove(key).catch(() => {});
			}
		};
	}
}

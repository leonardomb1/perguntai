import { StoreNotFoundError, type StoreBackend, type StoreLease, type StoreStat } from './types';

/**
 * Azure Blob backend. Audit appends use append blobs; the scheduler lease maps
 * onto Azure's native blob lease (a real distributed lock). The SDK loads
 * lazily so deployments on the local backend never pay for it.
 */

export interface AzureConfig {
	container: string;
	prefix?: string;
	connectionString?: string;
	accountName?: string;
	accountKey?: string;
	endpoint?: string;
}

type Sdk = typeof import('@azure/storage-blob');
type ContainerClient = import('@azure/storage-blob').ContainerClient;

export class AzureStore implements StoreBackend {
	readonly name = 'azure';
	private readonly cfg: AzureConfig;
	private readonly prefix: string;
	private clientP: Promise<{ sdk: Sdk; container: ContainerClient }> | null = null;

	constructor(cfg: AzureConfig) {
		this.cfg = cfg;
		this.prefix = cfg.prefix ? cfg.prefix.replace(/\/+$/, '') + '/' : '';
	}

	private client() {
		if (!this.clientP) {
			this.clientP = (async () => {
				const sdk = await import('@azure/storage-blob');
				const service = this.cfg.connectionString
					? sdk.BlobServiceClient.fromConnectionString(this.cfg.connectionString)
					: (() => {
							if (!this.cfg.accountName || !this.cfg.accountKey)
								throw new Error('store(azure): provide connectionString, or accountName + accountKey');
							const url = this.cfg.endpoint ?? `https://${this.cfg.accountName}.blob.core.windows.net`;
							return new sdk.BlobServiceClient(
								url,
								new sdk.StorageSharedKeyCredential(this.cfg.accountName, this.cfg.accountKey)
							);
						})();
				const container = service.getContainerClient(this.cfg.container);
				await container.createIfNotExists();
				return { sdk, container };
			})();
			this.clientP.catch(() => (this.clientP = null));
		}
		return this.clientP;
	}

	private key(key: string): string {
		return this.prefix + key;
	}

	private isNotFound(sdk: Sdk, err: unknown): boolean {
		return err instanceof sdk.RestError && err.statusCode === 404;
	}

	async readBinary(key: string): Promise<Uint8Array> {
		const { sdk, container } = await this.client();
		try {
			return new Uint8Array(await container.getBlobClient(this.key(key)).downloadToBuffer());
		} catch (err) {
			if (this.isNotFound(sdk, err)) throw new StoreNotFoundError(key);
			throw err;
		}
	}

	async readText(key: string): Promise<string> {
		return Buffer.from(await this.readBinary(key)).toString('utf8');
	}

	async write(key: string, data: string | Uint8Array): Promise<void> {
		const { container } = await this.client();
		const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
		await container.getBlockBlobClient(this.key(key)).uploadData(body);
	}

	async append(key: string, text: string): Promise<void> {
		const { container } = await this.client();
		const blob = container.getAppendBlobClient(this.key(key));
		await blob.createIfNotExists();
		const body = Buffer.from(text, 'utf8');
		await blob.appendBlock(body, body.length);
	}

	async remove(key: string): Promise<void> {
		const { container } = await this.client();
		await container.getBlobClient(this.key(key)).deleteIfExists();
	}

	async removePrefix(prefix: string): Promise<void> {
		for (const key of await this.list(prefix)) await this.remove(key);
	}

	async list(prefix: string): Promise<string[]> {
		const { container } = await this.client();
		const out: string[] = [];
		for await (const blob of container.listBlobsFlat({ prefix: this.key(prefix) })) {
			out.push(this.prefix ? blob.name.slice(this.prefix.length) : blob.name);
		}
		return out;
	}

	async stat(key: string): Promise<StoreStat | null> {
		const { sdk, container } = await this.client();
		try {
			const p = await container.getBlobClient(this.key(key)).getProperties();
			return {
				size: p.contentLength ?? 0,
				lastModified: p.lastModified ?? new Date(0),
				etag: p.etag ?? ''
			};
		} catch (err) {
			if (this.isNotFound(sdk, err)) return null;
			throw err;
		}
	}

	/** Azure blob leases ARE distributed locks; 60s duration, renewed by the holder. */
	async acquireLease(key: string, _ttlMs: number): Promise<StoreLease | null> {
		const { container } = await this.client();
		const blob = container.getBlockBlobClient(this.key(key));
		try {
			await blob.uploadData(Buffer.from('lock'), { conditions: { ifNoneMatch: '*' } });
		} catch {
			// Exists already — that's fine, we only need a blob to lease.
		}
		const lease = blob.getBlobLeaseClient();
		try {
			await lease.acquireLease(60);
		} catch {
			return null;
		}
		return {
			renew: async () => {
				try {
					await lease.renewLease();
					return true;
				} catch {
					return false;
				}
			},
			release: async () => {
				await lease.releaseLease().catch(() => {});
			}
		};
	}
}

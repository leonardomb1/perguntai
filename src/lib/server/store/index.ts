import { env } from '$env/dynamic/private';
import { LocalStore } from './local';
import { AzureStore } from './azure';
import { S3Store } from './s3';
import type { StoreBackend } from './types';

export { StoreNotFoundError } from './types';
export type { StoreBackend, StoreLease, StoreStat } from './types';

/**
 * The app data store: every piece of user/app state that used to live as
 * files under DATA_DIR goes through this. STORAGE picks the backend:
 *
 *  - local (default) — files under DATA_DIR, byte-compatible with the
 *    pre-store layout. Fine for one host, replicas included (shared volume).
 *  - azure — Azure Blob Storage. For replicas across hosts.
 *  - s3    — AWS S3 or any S3-compatible endpoint. Same purpose.
 *
 * Keys keep the old relative paths ('settings/<user>.json', 'audit/…'), so a
 * one-time copy of DATA_DIR into the bucket/container is the whole migration.
 */

function required(key: string): string {
	const v = env[key];
	if (!v) throw new Error(`store: missing required env ${key}`);
	return v;
}

function build(): StoreBackend {
	const backend = (env.STORAGE ?? 'local').toLowerCase();
	switch (backend) {
		case 'local':
			return new LocalStore(env.DATA_DIR ?? 'data');
		case 'azure':
			return new AzureStore({
				container: required('AZURE_STORAGE_CONTAINER'),
				connectionString: env.AZURE_STORAGE_CONNECTION_STRING || undefined,
				accountName: env.AZURE_STORAGE_ACCOUNT || undefined,
				accountKey: env.AZURE_STORAGE_KEY || undefined,
				endpoint: env.AZURE_STORAGE_ENDPOINT || undefined,
				prefix: env.AZURE_STORAGE_PREFIX || undefined
			});
		case 's3':
			return new S3Store({
				bucket: required('S3_BUCKET'),
				region: env.S3_REGION || undefined,
				endpoint: env.S3_ENDPOINT || undefined,
				accessKeyId: required('S3_ACCESS_KEY_ID'),
				secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
				forcePathStyle: env.S3_FORCE_PATH_STYLE ? env.S3_FORCE_PATH_STYLE === 'true' : undefined,
				prefix: env.S3_PREFIX || undefined
			});
		default:
			throw new Error(`store: unknown STORAGE backend '${backend}' (expected local|azure|s3)`);
	}
}

let instance: StoreBackend | null = null;

export function store(): StoreBackend {
	if (!instance) instance = build();
	return instance;
}

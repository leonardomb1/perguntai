import { writeFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { env } from '$env/dynamic/private';

/**
 * Regenerates the warehouse catalog (schema.json) from StarRocks — the same job
 * as scripts/sync-schema.js, callable at runtime so it can be triggered by a
 * route (e.g. an external cron) instead of the docker sleep-loop sidecar. Writes
 * to SCHEMA_PATH in the shared volume; the app picks it up by mtime, no restart.
 *
 * Uses the STARROCKS_SYNC_USER/PASSWORD service account (NOT any end-user), and
 * STARROCKS_SYNC_DATABASES: a comma-list where each entry is either a literal
 * database name, a glob (e.g. "dm_*"), or "all"/"*" to take every non-system DB.
 * Globs and "all" are resolved against SHOW DATABASES, so "gold,dm_*" syncs gold
 * plus every datamart without hand-listing them.
 */

const SYSTEM_DBS = new Set(['information_schema', '_statistics_', 'sys']);

/** Case-insensitive glob → RegExp: `*` = any run, `?` = one char; rest literal. */
function globToRegExp(pattern: string): RegExp {
	const body = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*')
		.replace(/\?/g, '.');
	return new RegExp(`^${body}$`, 'i');
}

/** Non-system, non-internal databases the sync account can see. */
async function liveDatabases(conn: mysql.Connection): Promise<string[]> {
	const [dbRows] = await conn.query('SHOW DATABASES');
	return (dbRows as Record<string, unknown>[])
		.map((r) => String(Object.values(r)[0] ?? ''))
		.filter((d) => d && !SYSTEM_DBS.has(d.toLowerCase()) && !d.startsWith('_'));
}

/**
 * Expand the configured entries against the live database list. Literal names
 * pass through; "all"/"*" takes everything; any entry with `*`/`?` is matched
 * as a glob. SHOW DATABASES is only queried when discovery is actually needed.
 */
async function resolveDatabases(conn: mysql.Connection, raw: string[]): Promise<string[]> {
	const discoverAll = raw.some((d) => d.toLowerCase() === 'all' || d === '*');
	const patterns = raw.filter((d) => d !== '*' && /[*?]/.test(d));
	if (!discoverAll && patterns.length === 0) return raw;

	const live = await liveDatabases(conn);
	if (discoverAll) return live;

	const out = new Set<string>();
	for (const entry of raw) {
		if (/[*?]/.test(entry)) {
			const re = globToRegExp(entry);
			for (const db of live) if (re.test(db)) out.add(db);
		} else {
			out.add(entry); // literal name, kept even if not currently present
		}
	}
	return [...out];
}

export interface SyncResult {
	syncedAt: string;
	databases: { name: string; tables: number }[];
	columns: number;
}

async function doSync(): Promise<SyncResult> {
	const user = env.STARROCKS_SYNC_USER;
	const password = env.STARROCKS_SYNC_PASSWORD;
	if (!user || !password) {
		throw new Error('STARROCKS_SYNC_USER / STARROCKS_SYNC_PASSWORD not configured');
	}

	const configured = (env.STARROCKS_SYNC_DATABASES || env.STARROCKS_DATABASE || '')
		.split(',')
		.map((d) => d.trim())
		.filter(Boolean);
	if (configured.length === 0) {
		throw new Error('No databases configured (set STARROCKS_SYNC_DATABASES)');
	}

	const conn = await mysql.createConnection({
		host: env.STARROCKS_HOST ?? 'localhost',
		port: Number(env.STARROCKS_PORT ?? 9030),
		user,
		password,
		enableCleartextPlugin: true
	});
	try {
		const databases = await resolveDatabases(conn, configured);
		if (databases.length === 0) {
			throw new Error(
				`No databases matched ${JSON.stringify(configured)} (check the sync account's grants)`
			);
		}

		const [tables] = await conn.query<mysql.RowDataPacket[]>(
			`SELECT TABLE_SCHEMA db, TABLE_NAME name, TABLE_TYPE type, TABLE_COMMENT comment
			 FROM information_schema.tables
			 WHERE TABLE_SCHEMA IN (?) ORDER BY TABLE_SCHEMA, TABLE_NAME`,
			[databases]
		);
		const [columns] = await conn.query<mysql.RowDataPacket[]>(
			`SELECT TABLE_SCHEMA db, TABLE_NAME tbl, COLUMN_NAME name, COLUMN_TYPE type, COLUMN_COMMENT comment
			 FROM information_schema.columns
			 WHERE TABLE_SCHEMA IN (?) ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
			[databases]
		);

		const byTable = new Map<string, { name: string; type: string; comment?: string }[]>();
		for (const c of columns) {
			const key = `${c.db}.${c.tbl}`;
			if (!byTable.has(key)) byTable.set(key, []);
			byTable.get(key)!.push({ name: c.name, type: c.type, ...(c.comment ? { comment: c.comment } : {}) });
		}

		const schema = {
			syncedAt: new Date().toISOString().slice(0, 10),
			databases: databases.map((db) => ({
				name: db,
				tables: tables
					.filter((t) => t.db === db)
					.map((t) => ({
						name: t.name,
						...(t.type === 'VIEW' ? { view: true } : {}),
						...(t.comment ? { comment: t.comment } : {}),
						columns: byTable.get(`${db}.${t.name}`) ?? []
					}))
			}))
		};

		await writeFile(env.SCHEMA_PATH ?? 'schema.json', JSON.stringify(schema, null, '\t') + '\n');
		return {
			syncedAt: schema.syncedAt,
			databases: schema.databases.map((d) => ({ name: d.name, tables: d.tables.length })),
			columns: columns.length
		};
	} finally {
		await conn.end().catch(() => {});
	}
}

// Dedupe concurrent triggers (a cron overlapping a manual run) onto one run.
let inFlight: Promise<SyncResult> | null = null;

export function runSchemaSync(): Promise<SyncResult> {
	if (!inFlight) inFlight = doSync().finally(() => (inFlight = null));
	return inFlight;
}

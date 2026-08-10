#!/usr/bin/env node
/**
 * Syncs the StarRocks schema into schema.json, which the app injects into the
 * agent's system prompt (see src/lib/server/schema.ts).
 *
 * Usage:
 *   STARROCKS_SYNC_USER=<user> STARROCKS_SYNC_PASSWORD=<pass> npm run sync-schema
 *
 * Host/port come from .env; credentials are passed only for this run (the app
 * itself holds no database service account). Databases to sync come from
 * STARROCKS_SYNC_DATABASES (comma-separated), falling back to STARROCKS_DATABASE.
 * Each entry is a literal name, a glob (e.g. "dm_*"), or "all"/"*" for every
 * non-system DB — so "gold,dm_*" syncs gold plus every datamart. Every synced
 * table is presented to the agent database-qualified — mind the system-prompt
 * size before adding large layers (bronze alone is 300+ tables).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import mysql from 'mysql2/promise';

function loadEnv() {
	const out = {};
	try {
		for (const line of readFileSync('.env', 'utf8').split('\n')) {
			const i = line.indexOf('=');
			if (i > 0 && !line.startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
		}
	} catch {
		/* no .env — rely on process env */
	}
	return { ...out, ...process.env };
}

const SYSTEM_DBS = new Set(['information_schema', '_statistics_', 'sys']);

/** Case-insensitive glob → RegExp: `*` = any run, `?` = one char; rest literal. */
function globToRegExp(pattern) {
	const body = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*')
		.replace(/\?/g, '.');
	return new RegExp(`^${body}$`, 'i');
}

const env = loadEnv();
const user = env.STARROCKS_SYNC_USER;
const password = env.STARROCKS_SYNC_PASSWORD;
const configured = (env.STARROCKS_SYNC_DATABASES || env.STARROCKS_DATABASE || '')
	.split(',')
	.map((d) => d.trim())
	.filter(Boolean);

if (!user || !password || configured.length === 0) {
	console.error(
		'Usage: STARROCKS_SYNC_USER=<user> STARROCKS_SYNC_PASSWORD=<pass> npm run sync-schema\n' +
			'(host/port from .env; databases from STARROCKS_SYNC_DATABASES [literal names, globs like "dm_*", or "all"] or STARROCKS_DATABASE)'
	);
	process.exit(1);
}

const conn = await mysql.createConnection({
	host: env.STARROCKS_HOST ?? 'localhost',
	port: Number(env.STARROCKS_PORT ?? 9030),
	user,
	password,
	enableCleartextPlugin: true
});

// Expand "all"/"*" and any glob entries against the live database list. Literal
// names pass through. SHOW DATABASES is only queried when discovery is needed.
let databases = configured;
const discoverAll = configured.some((d) => d.toLowerCase() === 'all' || d === '*');
const patterns = configured.filter((d) => d !== '*' && /[*?]/.test(d));
if (discoverAll || patterns.length > 0) {
	const [dbRows] = await conn.query('SHOW DATABASES');
	const live = dbRows
		.map((r) => String(Object.values(r)[0] ?? ''))
		.filter((d) => d && !SYSTEM_DBS.has(d.toLowerCase()) && !d.startsWith('_'));
	if (discoverAll) {
		databases = live;
	} else {
		const out = new Set();
		for (const entry of configured) {
			if (/[*?]/.test(entry)) {
				const re = globToRegExp(entry);
				for (const db of live) if (re.test(db)) out.add(db);
			} else {
				out.add(entry);
			}
		}
		databases = [...out];
	}
	console.log(`Resolved ${databases.length} databases: ${databases.join(', ')}`);
}

if (databases.length === 0) {
	console.error(
		`No databases matched ${JSON.stringify(configured)} (check the sync account's grants)`
	);
	process.exit(1);
}

const [tables] = await conn.query(
	`SELECT TABLE_SCHEMA db, TABLE_NAME name, TABLE_TYPE type, TABLE_COMMENT comment
	 FROM information_schema.tables
	 WHERE TABLE_SCHEMA IN (?) ORDER BY TABLE_SCHEMA, TABLE_NAME`,
	[databases]
);

const [columns] = await conn.query(
	`SELECT TABLE_SCHEMA db, TABLE_NAME tbl, COLUMN_NAME name, COLUMN_TYPE type, COLUMN_COMMENT comment
	 FROM information_schema.columns
	 WHERE TABLE_SCHEMA IN (?) ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
	[databases]
);

await conn.end();

const byTable = new Map();
for (const c of columns) {
	const key = `${c.db}.${c.tbl}`;
	if (!byTable.has(key)) byTable.set(key, []);
	byTable.get(key).push({ name: c.name, type: c.type, ...(c.comment ? { comment: c.comment } : {}) });
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

const path = env.SCHEMA_PATH || 'schema.json';
writeFileSync(path, JSON.stringify(schema, null, '\t') + '\n');
const counts = schema.databases.map((d) => `${d.name}: ${d.tables.length} tables`).join(', ');
console.log(`Wrote ${path} (${counts}, ${columns.length} columns total)`);

import { readFile, stat } from 'node:fs/promises';
import { env } from '$env/dynamic/private';

/**
 * Locally synced warehouse schema (schema.json, produced by `npm run
 * sync-schema`). Served to the agent through tools, never injected into the
 * system prompt:
 *
 *  - `schemaContext()` → a compact CATALOG (every table/view name + comment,
 *    database-qualified), returned by the `listTables` tool so the agent knows
 *    what exists without SHOW TABLES.
 *  - `tableSchemas()`  → full column details for specific tables, served by the
 *    `getTableSchema` tool — from the local file, no DESCRIBE round-trip.
 *
 * Both accept an optional `visibleDbs` set (the databases the CALLING USER can
 * actually see in StarRocks — see warehouse-access.ts). When given, the catalog
 * and schema lookups are filtered to those databases, so a user never sees the
 * existence of tables their grants can't reach. StarRocks still enforces access
 * on the query itself; this only trims what's shown.
 *
 * Supports MULTIPLE databases via STARROCKS_SYNC_DATABASES; all names are
 * database-qualified (query connections have no default database). Cached by
 * file mtime — re-syncing is picked up without a restart.
 */

interface SchemaTable {
	name: string;
	view?: boolean;
	comment?: string;
	columns: { name: string; type: string; comment?: string }[];
}

interface SchemaDatabase {
	name: string;
	tables: SchemaTable[];
}

interface SchemaFile {
	syncedAt: string;
	databases: SchemaDatabase[];
}

let cache: { mtime: number; schema: SchemaFile } | null = null;

/** Accepts both the current multi-db format and the legacy single-db one. */
function normalize(parsed: Record<string, unknown>): SchemaFile {
	if (Array.isArray(parsed.databases)) return parsed as unknown as SchemaFile;
	return {
		syncedAt: (parsed.syncedAt as string) ?? '',
		databases: [
			{ name: (parsed.database as string) ?? 'gold', tables: (parsed.tables as SchemaTable[]) ?? [] }
		]
	};
}

function visibleDatabasesOf(schema: SchemaFile, visibleDbs?: Set<string> | null): SchemaDatabase[] {
	if (!visibleDbs) return schema.databases;
	return schema.databases.filter((db) => visibleDbs.has(db.name.toLowerCase()));
}

function renderCatalog(schema: SchemaFile, visibleDbs?: Set<string> | null): string {
	const dbs = visibleDatabasesOf(schema, visibleDbs);
	if (dbs.length === 0) {
		// The synced catalog is a fast-path, NOT the definition of the user's
		// access — they may hold grants on databases that were never synced. Do
		// not claim "no access"; fall back to live exploration.
		return (
			'\n\nNone of the pre-synced databases are visible to your StarRocks account — but you may ' +
			'still have access to OTHER databases that were not synced into this catalog. Do NOT tell the ' +
			'user they have no warehouse access. Run `SHOW DATABASES` (via queryDatabase), then ' +
			'`SHOW TABLES FROM <db>` / `DESCRIBE <db>.<table>` to explore what your account can reach, and ' +
			'query with fully-qualified names.'
		);
	}
	const sections = dbs.map((db) => {
		const lines = db.tables.map((t) => `- ${db.name}.${t.name}${t.comment ? ` — ${t.comment}` : ''}`);
		return `Database "${db.name}":\n` + lines.join('\n');
	});
	const example = `${dbs[0].name}.${dbs[0].tables[0]?.name ?? 'table_name'}`;
	return (
		`\n\nAvailable tables/views (synced ${schema.syncedAt}) that your account can access:\n\n` +
		sections.join('\n\n') +
		'\n\nALWAYS fully qualify every table with its database in SQL (e.g. ' +
		`${example}) — connections have NO default database, so unqualified names fail. Before writing SQL, ` +
		'call getTableSchema for the exact columns of the tables you will query. This is the synced ' +
		'fast-path; if you need a table that is NOT listed, you may also run SHOW DATABASES / SHOW TABLES ' +
		'to reach databases not yet in this catalog.'
	);
}

async function load(): Promise<SchemaFile | null> {
	const path = env.SCHEMA_PATH ?? 'schema.json';
	try {
		const s = await stat(path);
		if (!cache || cache.mtime !== s.mtimeMs) {
			cache = { mtime: s.mtimeMs, schema: normalize(JSON.parse(await readFile(path, 'utf8'))) };
		}
		return cache.schema;
	} catch {
		return null; // no schema file — the agent explores with SHOW/DESCRIBE as before
	}
}

/** Catalog block for the listTables tool ('' when schema.json is absent),
 *  optionally filtered to the databases the user can see. */
export async function schemaContext(visibleDbs?: Set<string> | null): Promise<string> {
	const schema = await load();
	return schema ? renderCatalog(schema, visibleDbs) : '';
}

/**
 * Column details for specific tables, for the getTableSchema tool. Accepts
 * qualified names (gold.x — canonical) and bare names when unambiguous. Tables
 * in databases the user can't see are treated as missing.
 */
export async function tableSchemas(
	names: string[],
	visibleDbs?: Set<string> | null
): Promise<{ tables: SchemaTable[]; missing: string[] } | null> {
	const schema = await load();
	if (!schema) return null;

	const qualified = new Map<string, SchemaTable>();
	const bare = new Map<string, SchemaTable | 'ambiguous'>();
	for (const db of visibleDatabasesOf(schema, visibleDbs)) {
		for (const t of db.tables) {
			const entry = { ...t, name: `${db.name}.${t.name}` };
			qualified.set(entry.name.toLowerCase(), entry);
			const key = t.name.toLowerCase();
			bare.set(key, bare.has(key) ? 'ambiguous' : entry);
		}
	}

	const tables: SchemaTable[] = [];
	const missing: string[] = [];
	for (const raw of names) {
		const key = raw.toLowerCase();
		const hit = qualified.get(key) ?? bare.get(key);
		if (hit && hit !== 'ambiguous') tables.push(hit);
		else missing.push(raw);
	}
	return { tables, missing };
}

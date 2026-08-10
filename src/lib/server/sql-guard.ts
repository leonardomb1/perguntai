/**
 * The single SQL gate for every statement the model composes.
 *
 * What this guards is narrower than it looks: StarRocks already authorizes each
 * statement against the logged-in user's own grants (tools connect AS the user),
 * so this is not what stops a user reaching data they shouldn't. It stops the
 * MODEL from composing a destructive statement under grants the user does hold.
 *
 * Hence the default is read-only for everyone, and `allowWrites` — an admin-set
 * per-user flag (AccessUser.sqlWrite) — only widens it to ordinary DML. The
 * irreversible statements stay blocked for EVERYONE, flag or not: a bad INSERT
 * is fixable, a DROP guessed from a misread question is not.
 */

const READ = /^(select|show|describe|desc|explain|with)\b/i;

/**
 * Ordinary DML + table creation. DROP / TRUNCATE / ALTER / GRANT / REVOKE need
 * no denylist entry — they simply never match this allowlist.
 */
const WRITE = /^(insert|update|delete|create)\b/i;

/**
 * Forms that DO start with an allowed keyword but wipe existing data, so the
 * prefix allowlist alone would let them through.
 */
const DESTRUCTIVE = /^(insert\s+overwrite|create\s+or\s+replace)\b/i;

export interface SqlGuardOptions {
	/** Per-user capability from AccessUser.sqlWrite. Off unless an admin grants it. */
	allowWrites?: boolean;
}

/** Returns the cleaned statement, or null when the guard rejects it. */
export function checkStatement(sql: string, { allowWrites = false }: SqlGuardOptions = {}): string | null {
	const statement = sql.trim().replace(/;+\s*$/, '');
	if (statement.includes(';')) return null; // one statement per call — no stacking
	if (READ.test(statement)) return statement;
	if (allowWrites && WRITE.test(statement) && !DESTRUCTIVE.test(statement)) return statement;
	return null;
}

/**
 * Strict read-only check, for call sites that must NEVER write regardless of who
 * is running them: flow sqlCheck gates, and the dataQuery fetches behind
 * generateExcel / runPython.
 */
export function readOnlyStatement(sql: string): string | null {
	return checkStatement(sql);
}

import { connectAsUser } from './db';

/**
 * The databases a user can SEE in StarRocks. `SHOW DATABASES` is grant-aware —
 * it returns only what the account has some privilege on — so it's the cheapest
 * accurate signal of visibility. Used to filter the catalog (listTables /
 * getTableSchema) so a user never sees the existence of tables their grants
 * can't reach. StarRocks still enforces access on the query itself; this only
 * trims what's shown to the agent.
 *
 * Cached briefly per user so listTables + repeated getTableSchema calls in one
 * conversation don't each re-run SHOW DATABASES.
 */
const TTL_MS = 5 * 60_000;
const cache = new Map<string, { dbs: Set<string>; at: number }>();

export async function visibleDatabases(credentials: {
	username: string;
	password: string;
}): Promise<Set<string> | null> {
	const hit = cache.get(credentials.username);
	if (hit && Date.now() - hit.at < TTL_MS) return hit.dbs;

	let conn;
	try {
		conn = await connectAsUser(credentials, { selectDatabase: false });
		const [rows] = await conn.query('SHOW DATABASES');
		const dbs = new Set(
			(rows as Record<string, unknown>[])
				.map((r) => String(Object.values(r)[0] ?? '').toLowerCase())
				.filter(Boolean)
		);
		cache.set(credentials.username, { dbs, at: Date.now() });
		return dbs;
	} catch {
		// Couldn't determine (connection/permission hiccup) — return null so the
		// catalog is shown UNFILTERED rather than blank; queries stay enforced by
		// StarRocks either way.
		return null;
	} finally {
		await conn?.end().catch(() => {});
	}
}

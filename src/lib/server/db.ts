import mysql from 'mysql2/promise';
import { env } from '$env/dynamic/private';

/**
 * StarRocks speaks the MySQL wire protocol — the standard mysql2 driver works,
 * pointed at the FE node's query port (9030).
 *
 * StarRocks authenticates users via LDAPS with mysql_clear_password (it needs
 * the plaintext at the handshake to bind against LDAP), so the cleartext
 * plugin must be enabled. Use TLS or a trusted network between app and FE in
 * production.
 */

/**
 * Opens a short-lived connection authenticated AS THE GIVEN USER — the agent's
 * query tools run every statement under the caller's own StarRocks grants.
 * (Login itself no longer goes through StarRocks; it hits AD directly via the
 * Windmill k-auth route.)
 *
 * `selectDatabase: false` skips the default database in the handshake:
 * StarRocks kills the handshake outright (PROTOCOL_CONNECTION_LOST, no clean
 * access-denied) for a valid user who merely lacks access to the default
 * database.
 */
export async function connectAsUser(
	credentials: { username: string; password: string },
	{ selectDatabase = true }: { selectDatabase?: boolean } = {}
) {
	const database = selectDatabase ? env.STARROCKS_DATABASE : undefined;
	try {
		return await mysql.createConnection({
			host: env.STARROCKS_HOST ?? 'localhost',
			port: Number(env.STARROCKS_PORT ?? 9030),
			database,
			user: credentials.username,
			password: credentials.password,
			enableCleartextPlugin: true,
			connectTimeout: 5000
		});
	} catch (error) {
		// Same handshake-kill at query time → say what it actually means
		// instead of "Connection lost: The server closed the connection".
		if (database && (error as { code?: string }).code === 'PROTOCOL_CONNECTION_LOST') {
			throw new Error(
				`Could not open database "${database}" as ${credentials.username} — the account has no access to it`,
				{ cause: error }
			);
		}
		throw error;
	}
}

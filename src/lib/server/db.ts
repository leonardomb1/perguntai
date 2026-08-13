import mysql from 'mysql2/promise';
import { env } from '$env/dynamic/private';
import { currentIdToken } from './oidcStore';

/**
 * StarRocks speaks the MySQL wire protocol — the standard mysql2 driver works,
 * pointed at the FE node's query port (9030).
 *
 * Authentication is per user: every statement runs under the caller's own
 * StarRocks grants. Users are created `IDENTIFIED WITH authentication_jwt`, so
 * the credential is an authentik id_token rather than a password, minted on
 * demand from the user's stored refresh token (see ./oidcStore).
 */

/**
 * MySQL length-encoded string.
 * https://dev.mysql.com/doc/dev/mysql-server/latest/page_protocol_basic_dt_strings.html
 */
function lengthEncoded(buf: Buffer): Buffer {
	const n = buf.length;
	if (n < 251) return Buffer.concat([Buffer.from([n]), buf]);
	if (n < 65536) {
		const head = Buffer.alloc(3);
		head[0] = 0xfc;
		head.writeUInt16LE(n, 1);
		return Buffer.concat([head, buf]);
	}
	const head = Buffer.alloc(4);
	head[0] = 0xfd;
	head.writeUIntLE(n, 1, 3);
	return Buffer.concat([head, buf]);
}

/**
 * mysql2 has no built-in handler for the plugin StarRocks requests for JWT
 * users, so supply one. The payload is a capability byte followed by the
 * length-encoded id_token; sending the raw token instead makes the server read
 * its first byte as a length and truncate it, which surfaces as the
 * distinctly unhelpful "Missing second delimiter" JWT parse error.
 */
function openIdConnectPlugin(idToken: string) {
	return {
		authentication_openid_connect_client: () => () =>
			Buffer.concat([Buffer.from([0x01]), lengthEncoded(Buffer.from(idToken, 'utf8'))])
	};
}

export class WarehouseAuthRequired extends Error {
	constructor(username: string) {
		super(`No usable StarRocks credential for ${username} — the user must sign in again`);
		this.name = 'WarehouseAuthRequired';
	}
}

/**
 * Opens a short-lived connection authenticated AS THE GIVEN USER.
 *
 * `selectDatabase: false` skips the default database in the handshake:
 * StarRocks kills the handshake outright (PROTOCOL_CONNECTION_LOST, no clean
 * access-denied) for a valid user who merely lacks access to the default
 * database.
 */
export async function connectAsUser(
	credentials: { username: string; password?: string },
	{ selectDatabase = true }: { selectDatabase?: boolean } = {}
) {
	const database = selectDatabase ? env.STARROCKS_DATABASE : undefined;
	const base = {
		host: env.STARROCKS_HOST ?? 'localhost',
		port: Number(env.STARROCKS_PORT ?? 9030),
		database,
		user: credentials.username,
		connectTimeout: 5000
	};

	// Password path retained for service accounts (schema sync runs as the
	// read-only StarRocks user, which still authenticates natively).
	let options: mysql.ConnectionOptions;
	if (credentials.password) {
		options = { ...base, password: credentials.password, enableCleartextPlugin: true };
	} else {
		const idToken = await currentIdToken(credentials.username);
		if (!idToken) throw new WarehouseAuthRequired(credentials.username);
		options = { ...base, password: '', authPlugins: openIdConnectPlugin(idToken) };
	}

	try {
		return await mysql.createConnection(options);
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

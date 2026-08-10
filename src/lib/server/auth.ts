import { EncryptJWT, jwtDecrypt } from 'jose';
import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { isEnvAdmin, isUserAllowed, resolveRole } from './access';

export { isUserAllowed };

const TOKEN_TTL = '24h';

/**
 * The bearer token is an ENCRYPTED JWT (JWE, A256GCM), not a plain signed one.
 *
 * Downstream tool calls (StarRocks queries, Windmill) run as the logged-in
 * user, so the token carries the user's credentials. A signed-only JWT is
 * base64-readable by anyone who holds it; encrypting means only this server
 * can read the claims. Tampering is also impossible — AES-GCM authenticates
 * the ciphertext.
 */
function key(): Uint8Array {
	const value = env.JWT_SECRET;
	if (!value) throw new Error('JWT_SECRET is not set');
	// Derive a 256-bit key from whatever secret length was configured.
	return new Uint8Array(createHash('sha256').update(value).digest());
}

/**
 * Directory attributes captured at login (from the k-auth AD lookup) and carried
 * in the session token. Job title and cost center enrich the agent's sense of
 * who it's helping; `memberOf` (AD groups) is the basis for future
 * department-scoped knowledge. Cost center only comes back when the login
 * request asks for `fetchAdditionalData`.
 */
export interface UserProfile {
	title: string | null;
	employeeId: string | null;
	email: string | null;
	memberOf: string[];
	costCenterCode: string | null;
	costCenterDescription: string | null;
}

export interface AuthUser {
	username: string;
	displayName: string | null;
	/** Used by tools that authenticate per-user (StarRocks queries). */
	credentials: { username: string; password: string };
	/** AD directory attributes captured at login (absent on legacy tokens). */
	profile?: UserProfile;
	/**
	 * App admin (access.json role === 'admin', which env admins also are).
	 * Resolved LIVE by authenticateRequest on every request — deliberately NOT a
	 * token claim, so a demotion in the admin panel takes effect immediately
	 * instead of lingering for the token's 24h life.
	 */
	isAdmin?: boolean;
	/** Server/bootstrap admin (in the ADMIN_USERS env — the "SERVIDOR" badge).
	 *  Cannot be blocked or demoted. Also resolved live. */
	isPlatformAdmin?: boolean;
}

export type LoginResult =
	| { ok: true; token: string; username: string; displayName: string | null }
	| { ok: false; status: number; code: string; message: string };

/**
 * Verifies credentials against Active Directory via the Windmill HTTP route
 * /api/r/k-auth (wraps f/auth/auth_ldap; authenticated with the server-level
 * WINDMILL_AUTH_TOKEN — the user has no Windmill token before logging in).
 * The route maps AD outcomes onto HTTP statuses — 401 bad credentials, 403
 * expired/disabled/restricted accounts, 423 locked — with a
 * `{ error, message }` body; those become `ok: false` results the login route
 * relays to the user. 5xx (LDAP unreachable/timeout/config) throws, which the
 * caller surfaces as 503.
 *
 * On success the route returns the AD entry; the canonical identity becomes
 * its sAMAccountName (users may sign in with their e-mail), which is what the
 * allowlist and per-user StarRocks connections key on.
 */
export async function login(identifier: string, password: string): Promise<LoginResult> {
	const base = env.WINDMILL_BASE_URL?.replace(/\/+$/, '');
	if (!base) throw new Error('WINDMILL_BASE_URL is not set');
	const authToken = env.WINDMILL_AUTH_TOKEN;
	if (!authToken) throw new Error('WINDMILL_AUTH_TOKEN is not set');

	// The Windmill HTTP route name is deployment-specific (default: k-auth).
	const route = (env.WINDMILL_KAUTH_ROUTE || 'k-auth').replace(/^\/+|\/+$/g, '');
	const res = await fetch(`${base}/api/r/${route}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${authToken}`
		},
		// fetchAdditionalData pulls the cost-center attributes (extra directory
		// lookup) alongside the base entry.
		body: JSON.stringify({ identifier, password, fetchAdditionalData: true }),
		signal: AbortSignal.timeout(30_000)
	});

	if (res.status >= 500) {
		throw new Error(`k-auth failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
	}

	if (!res.ok) {
		const text = await res.text();
		let failure: { error?: string; message?: string } | null = null;
		try {
			failure = JSON.parse(text);
		} catch {
			// fall through — non-JSON means the ROUTE itself rejected the call
		}
		if (!failure?.error) {
			// Not the script's mapped { error, message } shape: Windmill refused
			// the request before the script ran (bad/missing WINDMILL_AUTH_TOKEN
			// returns a plain-text 401). Config error, never the user's fault.
			throw new Error(`k-auth rejected the call (${res.status}): ${text.slice(0, 300)}`);
		}
		return {
			ok: false,
			status: res.status,
			code: failure.error,
			message: failure.message ?? 'Invalid username or password'
		};
	}

	const entry = (await res.json()) as {
		sAMAccountName?: string;
		displayName?: string;
		title?: string;
		employeeID?: string;
		mail?: string;
		memberOf?: string[];
		additionalInfo?: { costCenterCode?: string; costCenterDescription?: string };
	};
	const username = (entry.sAMAccountName ?? identifier).toLowerCase();
	const displayName = entry.displayName ?? username;

	const profile: UserProfile = {
		title: entry.title?.trim() || null,
		employeeId: entry.employeeID ?? null,
		email: entry.mail ?? null,
		memberOf: Array.isArray(entry.memberOf) ? entry.memberOf : [],
		costCenterCode: entry.additionalInfo?.costCenterCode ?? null,
		costCenterDescription: entry.additionalInfo?.costCenterDescription ?? null
	};

	const token = await new EncryptJWT({
		displayName,
		credentials: { username, password },
		profile
	})
		.setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
		.setSubject(username)
		.setIssuedAt()
		.setExpirationTime(TOKEN_TTL)
		.encrypt(key());

	return { ok: true, token, username, displayName };
}

/** Decrypts and validates a bearer token, returning the authenticated user or null. */
export async function verifyToken(token: string): Promise<AuthUser | null> {
	try {
		const { payload } = await jwtDecrypt(token, key());
		const credentials = payload.credentials as AuthUser['credentials'] | undefined;
		if (!payload.sub || !credentials?.username) return null;
		return {
			username: payload.sub,
			displayName: (payload.displayName as string | null) ?? null,
			credentials,
			profile: (payload.profile as UserProfile | undefined) ?? undefined
		};
	} catch {
		return null;
	}
}

/** Extracts and verifies the `Authorization: Bearer <jwe>` header. */
export async function authenticateRequest(request: Request): Promise<AuthUser | null> {
	const header = request.headers.get('authorization');
	if (!header?.startsWith('Bearer ')) return null;
	const user = await verifyToken(header.slice('Bearer '.length));
	// Access is re-checked on EVERY request (not just at login) — blocking a
	// user in the admin panel locks them out on their next request, even
	// though their stateless token is still cryptographically valid.
	if (user && !(await isUserAllowed(user.username))) return null;
	if (user) {
		// Resolved live (same cached access.json read as isUserAllowed above), so
		// admin/platform-admin status is always current, never a stale token claim.
		user.isAdmin = (await resolveRole(user.username)) === 'admin';
		user.isPlatformAdmin = isEnvAdmin(user.username);
	}
	return user;
}

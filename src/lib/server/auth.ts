import { EncryptJWT, jwtDecrypt } from 'jose';
import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { isEnvAdmin, isUserAllowed, resolveRole } from './access';
import { looksLikeApiKey, resolveKeyOwner } from './apiKeys';

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
 * Directory attributes captured at login (now from the authentik id_token) and
 * carried in the session token. Job title and cost center enrich the agent's
 * sense of who it's helping; `memberOf` holds the IdP's groups and is what
 * department matching compares against.
 *
 * The field keeps its AD-era name because access.json bindings and the admin
 * UI already key on it; authentik's `groups` claim is mapped onto it. Title and
 * cost centre only appear if the provider is configured to emit those claims.
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
	/**
	 * Used by tools that authenticate per-user (StarRocks queries).
	 *
	 * `password` is no longer carried for interactive users: StarRocks accepts
	 * authentik id_tokens, which connectAsUser mints on demand from the stored
	 * refresh token. It remains optional so service accounts (schema sync) can
	 * still authenticate natively.
	 */
	credentials: { username: string; password?: string };
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

/**
 * Mints the app's bearer session from OIDC claims — the sign-in path now that
 * identity comes from authentik rather than an LDAP bind.
 *
 * The session deliberately carries NO warehouse credential: StarRocks is
 * reached with an id_token minted per connection from the server-side refresh
 * token, so a stolen bearer token grants the app, not the data warehouse.
 *
 * Directory attributes are mapped onto the shape the rest of the app already
 * consumes. `groups` replaces AD's `memberOf` — department matching compares
 * against whatever strings land here, and authentik ships groups inside the
 * standard `profile` scope.
 */
export async function sessionFromClaims(claims: {
	sub: string;
	preferred_username?: string;
	name?: string;
	email?: string;
	groups?: string[];
	title?: string;
	employee_id?: string;
	cost_center?: string;
	cost_center_description?: string;
}): Promise<{ token: string; username: string; displayName: string | null }> {
	const username = (claims.preferred_username ?? claims.sub).toLowerCase();
	const displayName = claims.name ?? username;

	const profile: UserProfile = {
		title: claims.title?.trim() || null,
		employeeId: claims.employee_id ?? null,
		email: claims.email ?? null,
		memberOf: Array.isArray(claims.groups) ? claims.groups : [],
		costCenterCode: claims.cost_center ?? null,
		costCenterDescription: claims.cost_center_description ?? null
	};

	const token = await new EncryptJWT({ displayName, credentials: { username }, profile })
		.setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
		.setSubject(username)
		.setIssuedAt()
		.setExpirationTime(TOKEN_TTL)
		.encrypt(key());

	return { token, username, displayName };
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

/**
 * Builds the session a personal API key stands for.
 *
 * A key is its owner and nothing more: it carries no claims of its own, so
 * permissions come from the live access.json lookup below, exactly as for an
 * interactive session. Warehouse queries likewise run under the owner's
 * StarRocks identity, since connectAsUser mints a token from the owner's stored
 * refresh token.
 *
 * The profile is absent, so department-scoped knowledge does not apply to key
 * traffic — deliberate: departments are matched from IdP claims captured at
 * sign-in, and a key never went through one.
 */
function userFromApiKey(username: string): AuthUser {
	return { username, displayName: username, credentials: { username } };
}

/**
 * Extracts and verifies the `Authorization: Bearer …` header, which carries
 * either an interactive session (an encrypted JWT) or a personal API key
 * (`pai_…`). Both resolve to the same AuthUser and the same live permission
 * checks below, so every endpoint is programmable without per-endpoint work.
 */
export async function authenticateRequest(request: Request): Promise<AuthUser | null> {
	const header = request.headers.get('authorization');
	if (!header?.startsWith('Bearer ')) return null;
	const presented = header.slice('Bearer '.length);

	const user = looksLikeApiKey(presented)
		? await resolveKeyOwner(presented).then((owner) => (owner ? userFromApiKey(owner) : null))
		: await verifyToken(presented);
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

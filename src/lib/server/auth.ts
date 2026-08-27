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
 * Downstream tool calls (StarRocks queries, MCP servers) run as the logged-in
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
 * What the directory said about the person at sign-in, carried in the session
 * token. `memberOf` holds the groups (each as its DN and its bare name for AD),
 * and `claims` every other sign-in claim — from the id_token or the LDAP entry
 * — keyed by claim name, plus the synthetic `user`. Department rules match on
 * these; title and e-mail also help the agent know who it is helping.
 */
export interface UserProfile {
	title: string | null;
	employeeId: string | null;
	email: string | null;
	memberOf: string[];
	claims: Record<string, string[]>;
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
	/** Set when the request authenticated with a personal API key. */
	apiKey?: { id: string; label: string; scope: 'chat' | 'full' };
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
 * Mints the app's bearer session from identity claims — the OIDC id_token,
 * or the same shape read from the directory by an LDAP bind (see ./ldap).
 *
 * An SSO session deliberately carries NO warehouse credential: StarRocks is
 * reached with an id_token minted per connection from the server-side refresh
 * token, so a stolen bearer token grants the app, not the data warehouse. A
 * password sign-in has no refresh token, so it carries the password instead.
 *
 * Directory attributes are mapped onto the shape the rest of the app already
 * consumes. `groups` replaces AD's `memberOf` — department matching compares
 * against whatever strings land here, and authentik ships groups inside the
 * standard `profile` scope.
 */
export interface IdentityClaims {
	sub: string;
	preferred_username?: string;
	name?: string;
	email?: string;
	groups?: string[];
	title?: string;
	employee_id?: string;
	[claim: string]: unknown;
}

/** Claims the token carries for the protocol, never worth a rule. */
const PROTOCOL_CLAIMS = new Set([
	'acr', 'amr', 'at_hash', 'aud', 'auth_time', 'azp', 'c_hash', 'exp', 'iat', 'iss', 'jti',
	'nbf', 'nonce', 's_hash', 'session_state', 'sid', 'sub', 'typ'
]);

function asList(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v !== '');
	if (typeof value === 'string') return value ? [value] : [];
	if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
	return [];
}

/**
 * Every claim as a bindable attribute, keyed by its own name — mapping a new
 * attribute at the IdP (or in LDAP_CLAIMS) needs no change here. Groups live
 * in `memberOf` and are folded back in by profileClaims().
 */
function bindableClaims(claims: IdentityClaims, username: string): Record<string, string[]> {
	const out: Record<string, string[]> = { user: [username] };
	for (const [name, value] of Object.entries(claims)) {
		if (PROTOCOL_CLAIMS.has(name) || name === 'groups') continue;
		const values = asList(value);
		if (values.length) out[name] = values;
	}
	return out;
}

/**
 * Which doors are open. OIDC needs an issuer, LDAP a directory URL; a
 * deployment sets either or both.
 */
export function authMethods(): { ldap: boolean; oidc: boolean } {
	return { ldap: !!env.LDAP_URL, oidc: !!env.OIDC_ISSUER };
}

export async function sessionFromClaims(
	claims: IdentityClaims,
	options: {
		/**
		 * Set for a password (LDAP) sign-in. There is no refresh token to mint
		 * warehouse id_tokens from, so the password rides inside the encrypted
		 * token — the pre-OIDC model — and connectAsUser takes its cleartext
		 * path. A JWE, so it never leaves this server readable.
		 */
		password?: string;
	} = {}
): Promise<{
	token: string;
	username: string;
	displayName: string | null;
	profile: UserProfile;
}> {
	const username = (claims.preferred_username ?? claims.sub).toLowerCase();
	const displayName = claims.name ?? username;

	const profile: UserProfile = {
		title: claims.title?.trim() || null,
		employeeId: claims.employee_id ?? null,
		email: claims.email ?? null,
		memberOf: Array.isArray(claims.groups) ? claims.groups : [],
		claims: bindableClaims(claims, username)
	};

	const credentials = options.password ? { username, password: options.password } : { username };
	const token = await new EncryptJWT({ displayName, credentials, profile })
		.setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
		.setSubject(username)
		.setIssuedAt()
		.setExpirationTime(TOKEN_TTL)
		.encrypt(key());

	return { token, username, displayName, profile };
}

/** Decrypts and validates a bearer token, returning the authenticated user or null. */
export async function verifyToken(token: string): Promise<AuthUser | null> {
	try {
		const { payload } = await jwtDecrypt(token, key());
		const credentials = payload.credentials as AuthUser['credentials'] | undefined;
		if (!payload.sub || !credentials?.username) return null;
		const profile = payload.profile as Partial<UserProfile> | undefined;
		return {
			username: payload.sub,
			displayName: (payload.displayName as string | null) ?? null,
			credentials,
			// Tokens minted before `claims` existed still verify; they just carry none.
			profile: profile
				? {
						title: profile.title ?? null,
						employeeId: profile.employeeId ?? null,
						email: profile.email ?? null,
						memberOf: Array.isArray(profile.memberOf) ? profile.memberOf : [],
						claims: profile.claims ?? {}
					}
				: undefined
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
function userFromApiKey(owner: {
	username: string;
	keyId: string;
	keyLabel: string;
	scope: 'chat' | 'full';
}): AuthUser {
	return {
		username: owner.username,
		displayName: owner.username,
		credentials: { username: owner.username },
		apiKey: { id: owner.keyId, label: owner.keyLabel, scope: owner.scope }
	};
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
	if (user && !(await isUserAllowed(user.username, user.profile))) return null;
	// Least privilege: a 'chat'-scoped key is data-plane only — the OpenAI-compat
	// surface, the app's chat endpoint, and the model catalog. Everything else
	// (conversations, settings, documents, admin) needs a 'full' key or a session.
	if (user?.apiKey?.scope === 'chat') {
		const path = new URL(request.url).pathname;
		const allowed =
			path.startsWith('/v1/') || path.startsWith('/api/chat') || path === '/api/models';
		if (!allowed) return null;
	}
	if (user) {
		// Resolved live (same cached access.json read as isUserAllowed above), so
		// admin/platform-admin status is always current, never a stale token claim.
		user.isAdmin = (await resolveRole(user.username, user.profile)) === 'admin';
		user.isPlatformAdmin = isEnvAdmin(user.username);
	}
	return user;
}

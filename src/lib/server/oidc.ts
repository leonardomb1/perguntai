import { createHash, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

/**
 * OIDC against authentik. Everything except the issuer is discovered, so a
 * provider change is one env var.
 *
 * The id_token is not only proof of identity here — it is also the credential
 * PerguntAI presents to StarRocks, which is configured to accept authentik
 * JWTs (`IDENTIFIED WITH authentication_jwt`). That is why the refresh token
 * matters: authentik's access/id tokens live ~5 minutes while a session lives
 * 24h, so a token captured at login is useless by the time a query runs. We
 * keep the refresh token (see ./oidcStore) and mint a fresh id_token per
 * warehouse connection.
 *
 * The id_token signature is NOT verified here: it arrives over the TLS back
 * channel straight from the token endpoint (OIDC Core 3.1.3.7). StarRocks does
 * verify it properly against the JWKS before honouring it.
 */

const TIMEOUT_MS = Number(env.OIDC_TIMEOUT_MS || 10_000);

function required(name: string): string {
	const value = env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

interface Discovery {
	authorization_endpoint: string;
	token_endpoint: string;
	end_session_endpoint?: string;
}

let cached: Promise<Discovery> | null = null;

async function fetchDiscovery(): Promise<Discovery> {
	const issuer = required('OIDC_ISSUER').replace(/\/*$/, '/');
	const url = new URL('.well-known/openid-configuration', issuer);

	const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!res.ok) throw new Error(`oidc: discovery failed (${res.status})`);

	const doc = (await res.json()) as Partial<Discovery>;
	if (!doc.authorization_endpoint || !doc.token_endpoint) {
		throw new Error('oidc: discovery document is missing required endpoints');
	}
	return doc as Discovery;
}

/** Cached process-wide; a failure is not cached so the next call retries. */
function discover(): Promise<Discovery> {
	if (!cached) {
		cached = fetchDiscovery().catch((err) => {
			cached = null;
			throw err;
		});
	}
	return cached;
}

export interface OidcClaims {
	sub: string;
	preferred_username?: string;
	name?: string;
	email?: string;
	groups?: string[];
	title?: string;
	employee_id?: string;
	cost_center?: string;
	cost_center_description?: string;
	[claim: string]: unknown;
}

export interface AuthStart {
	url: string;
	state: string;
	verifier: string;
}

/**
 * `offline_access` is what makes authentik return a refresh token; without it
 * the warehouse credential dies five minutes after login.
 */
function scopes(): string {
	return env.OIDC_SCOPES || 'openid profile email offline_access';
}

export async function authorizeUrl(
	redirectUri: string,
	{ forceLogin = false }: { forceLogin?: boolean } = {}
): Promise<AuthStart> {
	const { authorization_endpoint } = await discover();

	const state = randomBytes(32).toString('base64url');
	const verifier = randomBytes(32).toString('base64url');

	const url = new URL(authorization_endpoint);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', required('OIDC_CLIENT_ID'));
	url.searchParams.set('redirect_uri', redirectUri);
	url.searchParams.set('scope', scopes());
	url.searchParams.set('state', state);
	url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
	url.searchParams.set('code_challenge_method', 'S256');
	// Signing out of PerguntAI does not end the IdP session (other apps stay
	// signed in), so the post-logout sign-in would otherwise be answered
	// silently and look like the sign-out never happened.
	if (forceLogin) url.searchParams.set('prompt', 'login');

	return { url: url.toString(), state, verifier };
}

export interface TokenSet {
	claims: OidcClaims;
	idToken: string;
	refreshToken: string | null;
	expiresAt: number;
}

function toTokenSet(token: {
	id_token?: string;
	refresh_token?: string;
	expires_in?: number;
}): TokenSet {
	if (!token.id_token) throw new Error('oidc: token response carried no id_token');
	return {
		claims: decodeIdToken(token.id_token),
		idToken: token.id_token,
		refreshToken: token.refresh_token ?? null,
		// a minute of slack so a token is never handed out on the edge of expiry
		expiresAt: Date.now() + Math.max(0, (token.expires_in ?? 300) - 60) * 1000
	};
}

async function postToken(body: URLSearchParams): Promise<TokenSet> {
	const { token_endpoint } = await discover();

	body.set('client_id', required('OIDC_CLIENT_ID'));
	const secret = env.OIDC_CLIENT_SECRET;
	if (secret) body.set('client_secret', secret);

	const res = await fetch(token_endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body,
		signal: AbortSignal.timeout(TIMEOUT_MS)
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`oidc: token request failed (${res.status}) ${detail.slice(0, 200)}`);
	}
	return toTokenSet(await res.json());
}

export function exchange(code: string, verifier: string, redirectUri: string): Promise<TokenSet> {
	return postToken(
		new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
			code_verifier: verifier
		})
	);
}

/** Trades a stored refresh token for a fresh id_token (and usually a new refresh token). */
export function refresh(refreshToken: string): Promise<TokenSet> {
	return postToken(
		new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
	);
}

/** Payload only — see the note at the top of this file. */
export function decodeIdToken(idToken: string): OidcClaims {
	const parts = idToken.split('.');
	if (parts.length !== 3) throw new Error('oidc: malformed id_token');

	const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as OidcClaims;
	if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('oidc: id_token carries no sub');
	return claims;
}

/**
 * RP-initiated logout. authentik refuses a request carrying a
 * `post_logout_redirect_uri` without an `id_token_hint`, so the redirect is
 * only requested when we can prove which session is ending; without a hint the
 * IdP still ends its side, it just lands the user on its own page.
 */
export async function endSessionUrl(
	postLogoutRedirectUri: string,
	idTokenHint?: string
): Promise<string | null> {
	const { end_session_endpoint } = await discover();
	if (!end_session_endpoint) return null;

	const url = new URL(end_session_endpoint);
	url.searchParams.set('client_id', required('OIDC_CLIENT_ID'));
	if (idTokenHint) {
		url.searchParams.set('id_token_hint', idTokenHint);
		url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
	}
	return url.toString();
}

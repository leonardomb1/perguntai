import { env } from '$env/dynamic/private';

/**
 * The in-flight OIDC exchange, carried between /auth/login and /auth/callback.
 *
 * This is the app's only cookie and it is NOT an auth cookie: it holds a PKCE
 * verifier and CSRF state, lives ten minutes, and is deleted the moment the
 * callback runs. It cannot authorise anything, so it does not change the
 * bearer-token security model the API endpoints rely on — sessions are still
 * `Authorization: Bearer`, which is why `csrf.trustedOrigins` in vite.config.ts
 * stays as it is.
 *
 * It is unsigned on purpose: a tampered verifier or state simply fails the
 * exchange at the IdP, and the state is compared against what comes back.
 */
export const FLOW_COOKIE = 'perguntai_oidc';

export interface OidcFlow {
	state: string;
	verifier: string;
	redirectTo: string;
}

export function packFlow(flow: OidcFlow): string {
	return Buffer.from(JSON.stringify(flow)).toString('base64url');
}

export function unpackFlow(raw: string | undefined): OidcFlow | null {
	if (!raw) return null;
	try {
		const flow = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as OidcFlow;
		if (!flow.state || !flow.verifier) return null;
		return { ...flow, redirectTo: safeRedirect(flow.redirectTo) };
	} catch {
		return null;
	}
}

function secure(url: URL): boolean {
	const configured = env.COOKIE_SECURE;
	if (configured) return configured !== 'false';
	return (env.ORIGIN ?? url.origin).startsWith('https://');
}

export function flowCookieOptions(url: URL) {
	return {
		path: '/',
		httpOnly: true,
		sameSite: 'lax' as const,
		secure: secure(url),
		maxAge: 600
	};
}

/** Same-origin absolute paths only — never an attacker-supplied destination. */
export function safeRedirect(target: string | null | undefined): string {
	if (!target || !target.startsWith('/') || target.startsWith('//')) return '/';
	return target;
}

/**
 * The redirect_uri must match what is registered on the provider exactly, and
 * must be the PUBLIC origin — behind a proxy `url.origin` can be the internal
 * one, so ORIGIN wins when set.
 */
export function callbackUri(url: URL): string {
	return new URL('/auth/callback', env.ORIGIN || url.origin).toString();
}

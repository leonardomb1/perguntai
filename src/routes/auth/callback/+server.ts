import { redirect, type RequestHandler } from '@sveltejs/kit';
import { exchange } from '$lib/server/oidc';
import { FLOW_COOKIE, callbackUri, flowCookieOptions, unpackFlow } from '$lib/server/oidcFlow';
import { isUserAllowed, sessionFromClaims } from '$lib/server/auth';
import { logAudit, requestMeta } from '$lib/server/audit';
import { saveTokens } from '$lib/server/oidcStore';

/**
 * Completes the OIDC flow and hands the bearer session to the browser.
 *
 * The session is a bearer token in localStorage, not a cookie — that is the
 * app's existing model and every API call already sends
 * `Authorization: Bearer`. So the callback answers with a tiny page that
 * stores the token and navigates on, rather than setting a cookie and
 * rewriting ~10 components (and re-opening the CSRF question that
 * `csrf.trustedOrigins: ['*']` currently leaves alone).
 */
function handoffPage(token: string, displayName: string | null, redirectTo: string): Response {
	// Values are embedded as JSON literals; `<` is escaped so a claim can never
	// close the script tag.
	const literal = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

	return new Response(
		`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Entrando…</title><meta name="robots" content="noindex"></head>
<body style="font:15px system-ui;display:grid;place-items:center;height:100dvh;margin:0">
<p>Entrando…</p>
<script>
try {
  localStorage.setItem('perguntai_token', ${literal(token)});
  ${displayName ? `localStorage.setItem('perguntai_display_name', ${literal(displayName)});` : ''}
} catch (e) {}
location.replace(${literal(redirectTo)});
</script>
<noscript><a href="${redirectTo}">Continuar</a></noscript>
</body></html>`,
		{ headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
	);
}

export const GET: RequestHandler = async ({ url, cookies, request }) => {
	const flow = unpackFlow(cookies.get(FLOW_COOKIE));
	// One shot per flow: the code is spent either way, so the cookie goes now.
	cookies.delete(FLOW_COOKIE, flowCookieOptions(url));

	if (url.searchParams.get('error')) {
		console.error('oidc: provider refused the authorization', {
			error: url.searchParams.get('error'),
			description: url.searchParams.get('error_description')
		});
		redirect(303, '/login?error=interrupted');
	}

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	// A missing cookie means the flow expired or never started here; a state
	// mismatch means this callback belongs to some other flow. Both restart.
	if (!flow || !code || !state || state !== flow.state) redirect(303, '/login?error=interrupted');

	const tokens = await exchange(code, flow.verifier, callbackUri(url)).catch((err) => {
		console.error('oidc: code exchange failed', err);
		return null;
	});
	if (!tokens) redirect(303, '/login?error=unavailable');

	const session = await sessionFromClaims(tokens.claims).catch((err) => {
		console.error('oidc: could not build a session from the id_token', err);
		return null;
	});
	if (!session) redirect(303, '/login?error=unavailable');

	// Allowlist gate on the canonical username from the IdP, never on anything
	// the user typed.
	if (!(await isUserAllowed(session.username, session.profile))) {
		logAudit({
			actor: session.username,
			via: 'session',
			...requestMeta(request),
			category: 'auth',
			action: 'login.sso',
			status: 'denied',
			detail: { reason: 'not_in_allowlist' }
		});
		redirect(303, '/login?error=not_allowed');
	}
	logAudit({
		actor: session.username,
		via: 'session',
		...requestMeta(request),
		category: 'auth',
		action: 'login.sso',
		status: 'ok'
	});

	// The refresh token is what lets warehouse queries mint a fresh id_token
	// long after this login; without it StarRocks access dies in ~5 minutes.
	if (!tokens.refreshToken) {
		console.warn(
			`oidc: no refresh_token for ${session.username} — check the offline_access scope is bound to the provider`
		);
	}
	await saveTokens(session.username, tokens).catch((err) =>
		console.error('oidc: could not persist tokens', err)
	);

	return handoffPage(session.token, session.displayName, flow.redirectTo);
};

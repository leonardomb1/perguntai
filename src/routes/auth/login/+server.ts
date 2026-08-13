import { redirect, type RequestHandler } from '@sveltejs/kit';
import { authorizeUrl } from '$lib/server/oidc';
import { FLOW_COOKIE, callbackUri, flowCookieOptions, packFlow, safeRedirect } from '$lib/server/oidcFlow';

/**
 * Starts the OIDC flow. A GET so it can be a plain link/button on the login
 * page — nothing is mutated here beyond a short-lived flow cookie.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const redirectTo = safeRedirect(url.searchParams.get('redirectTo'));
	// Only the post-logout button sets this; ordinary visits keep the silent
	// SSO hand-off.
	const forceLogin = url.searchParams.get('prompt') === 'login';

	const start = await authorizeUrl(callbackUri(url), { forceLogin });

	cookies.set(
		FLOW_COOKIE,
		packFlow({ state: start.state, verifier: start.verifier, redirectTo }),
		flowCookieOptions(url)
	);
	redirect(303, start.url);
};

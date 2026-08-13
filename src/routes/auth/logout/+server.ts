import { json, type RequestHandler } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import { endSessionUrl } from '$lib/server/oidc';
import { currentIdToken, forgetTokens } from '$lib/server/oidcStore';
import { env } from '$env/dynamic/private';

/**
 * Signs the user out of PerguntAI only — the authentik session deliberately
 * survives, so other applications stay signed in.
 *
 * Dropping the stored refresh token is the part that actually matters: the
 * bearer token in localStorage is cleared by the client, but the refresh token
 * is what could still mint warehouse credentials, so it must not outlive the
 * session.
 *
 * `?signedout` on the return URL stops /login from immediately starting a new
 * flow, which the still-valid IdP session would answer silently.
 */
export const POST: RequestHandler = async ({ request, url }) => {
	const user = await authenticateRequest(request);

	let idTokenHint: string | undefined;
	if (user) {
		// Read before forgetting: authentik requires an id_token_hint to accept
		// our post-logout redirect.
		idTokenHint = (await currentIdToken(user.username).catch(() => null)) ?? undefined;
		await forgetTokens(user.username).catch(() => {});
	}

	const origin = env.ORIGIN || url.origin;
	const signedOut = new URL('/login?signedout', origin).toString();
	const redirectTo = await endSessionUrl(signedOut, idTokenHint).catch(() => null);

	return json({ ok: true, redirectTo: redirectTo ?? '/login?signedout' });
};

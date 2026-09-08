import { json, type RequestHandler } from '@sveltejs/kit';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '$env/dynamic/private';
import { jwksUri } from '$lib/server/oidc';
import { revokeSessions } from '$lib/server/logoutDenylist';
import { logAudit, requestMeta } from '$lib/server/audit';

/**
 * OIDC Back-Channel Logout 1.0: the IdP POSTs a signed logout token here when
 * a user's session ends (admin revocation, single logout). The token is
 * verified against the issuer's JWKS — unlike the id_token at login, this one
 * arrives unsolicited, so the signature IS the authentication. On success the
 * named sub/sid land in the denylist and every session carrying them dies on
 * its next request.
 *
 * Register this URL in authentik: provider → Logout Method "Back-channel",
 * Logout URI = https://<host>/auth/backchannel-logout.
 */

const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
async function jwks() {
	if (!jwksCache) jwksCache = createRemoteJWKSet(new URL(await jwksUri()));
	return jwksCache;
}

const bad = (reason: string) =>
	json({ error: 'invalid_request', error_description: reason }, {
		status: 400,
		headers: { 'cache-control': 'no-store' }
	});

export const POST: RequestHandler = async ({ request }) => {
	if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID) return bad('oidc is not configured');

	const form = await request.formData().catch(() => null);
	const logoutToken = form?.get('logout_token');
	if (typeof logoutToken !== 'string' || !logoutToken) return bad('missing logout_token');

	let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
	try {
		const issuer = env.OIDC_ISSUER.replace(/\/+$/, '');
		({ payload } = await jwtVerify(logoutToken, await jwks(), {
			issuer: [issuer, `${issuer}/`],
			audience: env.OIDC_CLIENT_ID,
			maxTokenAge: '5m',
			clockTolerance: 60
		}));
	} catch (err) {
		console.warn('backchannel-logout: token rejected:', err instanceof Error ? err.message : err);
		return bad('logout_token failed validation');
	}

	// Spec: the events claim must name the logout event, and nonce is prohibited
	// (it distinguishes a logout token from a replayed id_token).
	const events = payload.events as Record<string, unknown> | undefined;
	if (!events || !(LOGOUT_EVENT in events)) return bad('not a logout token');
	if ('nonce' in payload) return bad('nonce is prohibited in logout tokens');

	const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
	const sid = typeof payload.sid === 'string' ? payload.sid : undefined;
	if (!sub && !sid) return bad('logout token carries neither sub nor sid');

	await revokeSessions({ sub, sid });
	logAudit({
		actor: sub ?? `sid:${sid}`,
		via: 'session',
		...requestMeta(request),
		category: 'auth',
		action: 'logout.backchannel',
		status: 'ok',
		detail: { ...(sub ? { sub } : {}), ...(sid ? { sid } : {}) }
	});

	return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
};

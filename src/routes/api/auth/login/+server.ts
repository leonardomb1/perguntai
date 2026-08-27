import { json } from '@sveltejs/kit';
import { authMethods, isUserAllowed, sessionFromClaims } from '$lib/server/auth';
import { logAudit, requestMeta } from '$lib/server/audit';
import { ldapAuthenticate, type LdapRejection } from '$lib/server/ldap';
import { saveWarehousePassword } from '$lib/server/credentialStore';
import type { RequestHandler } from './$types';

/** Small in-memory sliding window per user+address: 10 attempts a minute. */
const attempts = new Map<string, number[]>();
function throttled(key: string, max = 10, windowMs = 60_000): boolean {
	const now = Date.now();
	const recent = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
	if (recent.length >= max) {
		attempts.set(key, recent);
		return true;
	}
	recent.push(now);
	attempts.set(key, recent);
	if (attempts.size > 10_000) {
		for (const [k, v] of attempts) if (v.every((t) => now - t >= windowMs)) attempts.delete(k);
	}
	return false;
}

const STATUS: Record<LdapRejection, number> = { invalid: 401, disabled: 403, expired: 403, locked: 423 };

/**
 * Username + password sign-in against the directory over LDAPS. Answers with
 * the same `{ token, displayName }` the OIDC callback hands over, so the client
 * session is identical whichever door was used. Rejections carry a `code` the
 * login page maps to a message; directory trouble is a 503, never the user's
 * fault.
 */
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	if (!authMethods().ldap) return json({ error: 'Password sign-in is not enabled' }, { status: 404 });

	let body: { username?: string; password?: string };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid request body' }, { status: 400 });
	}

	const username = String(body.username ?? '').trim();
	const password = String(body.password ?? '');
	if (!username || !password) {
		return json({ error: 'Username and password are required' }, { status: 400 });
	}
	if (throttled(`${username.toLowerCase()}:${getClientAddress()}`)) {
		return json({ error: 'Too many attempts', code: 'throttled' }, { status: 429 });
	}

	let result;
	try {
		result = await ldapAuthenticate(username, password);
	} catch (error) {
		console.error('ldap: sign-in failed against the directory', error);
		return json({ error: 'Authentication service unavailable' }, { status: 503 });
	}
	if (!result.ok) {
		logAudit({
			actor: username.toLowerCase(),
			via: 'session',
			...requestMeta(request),
			category: 'auth',
			action: 'login.password',
			status: 'denied',
			detail: { reason: result.reason }
		});
		return json({ error: 'Sign-in refused', code: result.reason }, { status: STATUS[result.reason] });
	}

	// Allowlist gate on the canonical account name from the directory, never on
	// what was typed — AD accepts several aliases for the same account.
	const session = await sessionFromClaims(result.claims, { password });
	if (!(await isUserAllowed(session.username, session.profile))) {
		logAudit({
			actor: session.username,
			via: 'session',
			...requestMeta(request),
			category: 'auth',
			action: 'login.password',
			status: 'denied',
			detail: { reason: 'not_in_allowlist' }
		});
		return json({ error: 'Not in the preview allowlist', code: 'not_in_allowlist' }, { status: 403 });
	}
	// Keep the warehouse credential fresh for API-key requests, which carry no
	// password of their own (see credentialStore).
	await saveWarehousePassword(session.username, password).catch((e) =>
		console.warn('warehouse credential save failed:', e)
	);
	logAudit({
		actor: session.username,
		via: 'session',
		...requestMeta(request),
		category: 'auth',
		action: 'login.password',
		status: 'ok'
	});
	return json({ token: session.token, displayName: session.displayName });
};

import { json } from '@sveltejs/kit';
import { isUserAllowed, login } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	let body: { username?: string; password?: string };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid request body' }, { status: 400 });
	}

	const { username, password } = body;
	if (!username || !password) {
		return json({ error: 'Username and password are required' }, { status: 400 });
	}

	try {
		const result = await login(username, password);
		if (!result.ok) {
			// AD-mapped outcome (401 bad credentials, 403 expired/disabled, 423
			// locked) — relay status and message so the user sees the real reason.
			return json({ error: result.message, code: result.code }, { status: result.status });
		}
		// Allowlist gate on the CANONICAL sAMAccountName, never on what was
		// typed — AD accepts several aliases for the same account (account
		// name, UPN, e-mail), so the identity is only known after the lookup.
		if (!(await isUserAllowed(result.username))) {
			return json({ error: 'Not in the preview allowlist', code: 'not_in_allowlist' }, { status: 403 });
		}
		return json({ token: result.token, displayName: result.displayName });
	} catch (error) {
		console.error('Login failed:', error);
		return json({ error: 'Authentication service unavailable' }, { status: 503 });
	}
};

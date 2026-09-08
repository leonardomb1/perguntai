import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import type { RequestHandler } from './$types';

/**
 * Session probe: the app calls this on load to learn whether the stored token
 * is still alive — the token is an encrypted JWT, so the client cannot read
 * its expiry. A 401 here sends the user to /login before they meet an app
 * full of silently empty lists.
 */
export const GET: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	return json({ username: user.username, displayName: user.displayName });
};

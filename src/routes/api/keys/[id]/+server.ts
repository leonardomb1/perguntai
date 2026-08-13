import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import { revokeKey } from '$lib/server/apiKeys';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ request, params }) => {
	// As with minting: keys cannot revoke keys, so this needs a real session.
	const header = request.headers.get('authorization') ?? '';
	if (header.startsWith('Bearer pai_')) return json({ error: 'Unauthorized' }, { status: 401 });

	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	// Scoped to the caller's own store, so one user can never revoke another's.
	const revoked = await revokeKey(user.username, params.id);
	return revoked ? json({ ok: true }) : json({ error: 'Key not found' }, { status: 404 });
};

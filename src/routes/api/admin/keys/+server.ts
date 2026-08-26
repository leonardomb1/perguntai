import { json } from '@sveltejs/kit';
import { authenticateRequest, type AuthUser } from '$lib/server/auth';
import { resolveRole } from '$lib/server/access';
import { listAllKeys, revokeKey } from '$lib/server/apiKeys';
import { logAudit, requestMeta } from '$lib/server/audit';
import type { RequestHandler } from './$types';

/** Fleet view of every user's API keys, with admin revocation. */
async function requireAdmin(request: Request): Promise<AuthUser | Response> {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	if ((await resolveRole(user.username, user.profile)) !== 'admin')
		return json({ error: 'Forbidden' }, { status: 403 });
	return user;
}

export const GET: RequestHandler = async ({ request }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;
	return json({ owners: await listAllKeys() });
};

export const DELETE: RequestHandler = async ({ request, url }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;

	const username = url.searchParams.get('username') ?? '';
	const id = url.searchParams.get('id') ?? '';
	if (!username || !id) return json({ error: 'username and id required' }, { status: 400 });

	const revoked = await revokeKey(username.toLowerCase(), id);
	if (revoked) {
		logAudit({
			actor: admin.username,
			via: 'session',
			...requestMeta(request),
			category: 'keys',
			action: 'key.admin_revoke',
			target: `${username.toLowerCase()}/${id}`,
			status: 'ok'
		});
	}
	return revoked ? json({ ok: true }) : json({ error: 'Key not found' }, { status: 404 });
};

import { json } from '@sveltejs/kit';
import { authenticateRequest, type AuthUser } from './auth';
import { resolveRole } from './access';

/** Role is enforced HERE, per request — hiding a page is UX, not security. */
export async function requireBuilder(request: Request): Promise<AuthUser | Response> {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	const role = await resolveRole(user.username, user.profile);
	if (role !== 'admin' && role !== 'builder') return json({ error: 'Forbidden' }, { status: 403 });
	return user;
}

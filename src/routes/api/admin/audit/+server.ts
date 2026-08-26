import { json } from '@sveltejs/kit';
import { authenticateRequest, type AuthUser } from '$lib/server/auth';
import { resolveRole } from '$lib/server/access';
import { pruneAudit, readAudit, type AuditCategory } from '$lib/server/audit';
import type { RequestHandler } from './$types';

/** The audit trail — admin-only, read-only (the log itself is append-only). */
async function requireAdmin(request: Request): Promise<AuthUser | Response> {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	if ((await resolveRole(user.username, user.profile)) !== 'admin')
		return json({ error: 'Forbidden' }, { status: 403 });
	return user;
}

const CATEGORIES = new Set(['auth', 'admin', 'keys', 'connectors', 'chat']);

export const GET: RequestHandler = async ({ request, url }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;

	const rawCategory = url.searchParams.get('category') ?? '';
	const events = await readAudit({
		limit: Number(url.searchParams.get('limit')) || 200,
		category: CATEGORIES.has(rawCategory) ? (rawCategory as AuditCategory) : undefined,
		actor: url.searchParams.get('actor') ?? undefined
	});
	void pruneAudit();
	return json({ events });
};

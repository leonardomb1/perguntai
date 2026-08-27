import { json } from '@sveltejs/kit';
import { authenticateRequest, type AuthUser } from '$lib/server/auth';
import { resolveRole } from '$lib/server/access';
import { createEmbedKey, listEmbedKeys, revokeEmbedKey } from '$lib/server/embedKeys';
import { logAudit, requestMeta } from '$lib/server/audit';
import type { RequestHandler } from './$types';

/**
 * Embed-key fleet (console → Capacidades): mint per-portal keys carrying their
 * own StarRocks service account and limits. The full key is returned exactly
 * once at mint time; the credential itself never leaves the server.
 */
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
	return json({ keys: await listEmbedKeys() });
};

export const POST: RequestHandler = async ({ request }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;
	const body = await request.json().catch(() => ({}));
	const label = typeof body.label === 'string' ? body.label.trim() : '';
	const starrocksUser = typeof body.starrocksUser === 'string' ? body.starrocksUser.trim() : '';
	const starrocksPassword = typeof body.starrocksPassword === 'string' ? body.starrocksPassword : '';
	if (!label || !starrocksUser || !starrocksPassword) {
		return json({ error: 'label, starrocksUser and starrocksPassword are required' }, { status: 400 });
	}
	const { key, record } = await createEmbedKey({
		label,
		starrocksUser,
		starrocksPassword,
		maxMessages: Number(body.maxMessages) || undefined,
		dailyTokens: Number(body.dailyTokens) || undefined,
		allowedOrigins: typeof body.allowedOrigins === 'string' ? body.allowedOrigins : undefined,
		createdBy: admin.username
	});
	logAudit({
		actor: admin.username,
		via: 'session',
		...requestMeta(request),
		category: 'keys',
		action: 'embedkey.create',
		target: record.id,
		status: 'ok',
		detail: { label: record.label, starrocksUser: record.starrocksUser }
	});
	return json({ key, record }, { status: 201 });
};

export const DELETE: RequestHandler = async ({ request, url }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;
	const id = url.searchParams.get('id');
	if (!id) return json({ error: 'Missing id' }, { status: 400 });
	const ok = await revokeEmbedKey(id);
	if (!ok) return json({ error: 'Not found' }, { status: 404 });
	logAudit({
		actor: admin.username,
		via: 'session',
		...requestMeta(request),
		category: 'keys',
		action: 'embedkey.revoke',
		target: id,
		status: 'ok'
	});
	return json({ ok: true });
};

import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import {
	isEnvAdmin,
	listAccessUsers,
	removeAccessUser,
	resolveRole,
	upsertAccessUser
} from '$lib/server/access';
import { usageSummary } from '$lib/server/usage';
import type { RequestHandler } from './$types';
import type { AuthUser } from '$lib/server/auth';

/** Role is enforced HERE, per request — hiding the panel is UX, not security. */
async function requireAdmin(request: Request): Promise<AuthUser | Response> {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	if ((await resolveRole(user.username)) !== 'admin')
		return json({ error: 'Forbidden' }, { status: 403 });
	return user;
}

export const GET: RequestHandler = async ({ request }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;

	const users = await listAccessUsers();
	const list = await Promise.all(
		Object.entries(users).map(async ([username, entry]) => ({
			username,
			...entry,
			envAdmin: isEnvAdmin(username),
			usage: await usageSummary(username)
		}))
	);
	list.sort((a, b) => a.username.localeCompare(b.username));
	return json({ users: list, openMode: list.length === 0 });
};

export const POST: RequestHandler = async ({ request }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;

	const body = await request.json().catch(() => ({}));
	if (typeof body.username !== 'string' || !body.username.trim()) {
		return json({ error: 'username is required' }, { status: 400 });
	}
	try {
		await upsertAccessUser(
			body.username,
			{ role: body.role === 'admin' || body.role === 'builder' ? body.role : 'user' },
			admin.username
		);
	} catch (e) {
		return json({ error: e instanceof Error ? e.message : 'invalid user' }, { status: 400 });
	}
	return json({ ok: true });
};

export const PATCH: RequestHandler = async ({ request }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;

	const body = await request.json().catch(() => ({}));
	if (typeof body.username !== 'string') return json({ error: 'username required' }, { status: 400 });

	const patch: {
		role?: 'admin' | 'builder' | 'user';
		blocked?: boolean;
		maxDailyTokens?: number | null;
		allowedModels?: string[];
		sqlWrite?: boolean;
		windmillWrite?: boolean;
	} = {};
	if (body.role === 'admin' || body.role === 'builder' || body.role === 'user')
		patch.role = body.role;
	if (typeof body.blocked === 'boolean') patch.blocked = body.blocked;
	if (typeof body.sqlWrite === 'boolean') patch.sqlWrite = body.sqlWrite;
	if (typeof body.windmillWrite === 'boolean') patch.windmillWrite = body.windmillWrite;
	if (body.maxDailyTokens === null) patch.maxDailyTokens = null;
	else if (typeof body.maxDailyTokens === 'number' && body.maxDailyTokens > 0)
		patch.maxDailyTokens = Math.round(body.maxDailyTokens);
	// upsertAccessUser validates/filters against the model registry.
	if (Array.isArray(body.allowedModels))
		patch.allowedModels = body.allowedModels.filter((x: unknown): x is string => typeof x === 'string');

	try {
		await upsertAccessUser(body.username, patch, admin.username);
	} catch (e) {
		return json({ error: e instanceof Error ? e.message : 'invalid update' }, { status: 400 });
	}
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ request, url }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;

	const username = url.searchParams.get('username') ?? '';
	if (!username) return json({ error: 'username required' }, { status: 400 });
	try {
		await removeAccessUser(username);
	} catch (e) {
		return json({ error: e instanceof Error ? e.message : 'cannot remove' }, { status: 400 });
	}
	return json({ ok: true });
};

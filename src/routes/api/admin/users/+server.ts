import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import {
	getDepartments,
	isEnvAdmin,
	isOpenMode,
	listAccessUsers,
	listPolicies,
	profileClaims,
	removeAccessUser,
	resolveRole,
	setPolicies,
	upsertAccessUser
} from '$lib/server/access';
import { listUsageUsers, usageSummary } from '$lib/server/usage';
import { logAudit, requestMeta } from '$lib/server/audit';
import type { RequestHandler } from './$types';
import type { AuthUser } from '$lib/server/auth';

/** Role is enforced HERE, per request — hiding the panel is UX, not security. */
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

	const users = await listAccessUsers();
	const policies = await listPolicies();
	const departments = await getDepartments();

	// Everyone: listed users PLUS anyone with recorded usage — policy-admitted
	// users have no access.json record but are just as real.
	const names = new Set([...Object.keys(users), ...(await listUsageUsers())]);
	const list = await Promise.all(
		[...names].map(async (username) => {
			const entry = users[username];
			const usage = await usageSummary(username);
			return {
				username,
				role: entry?.role ?? 'user',
				blocked: entry?.blocked ?? false,
				maxDailyTokens: entry?.maxDailyTokens ?? null,
				...(entry?.allowedModels ? { allowedModels: entry.allowedModels } : {}),
				sqlWrite: entry?.sqlWrite ?? false,
				windmillWrite: entry?.windmillWrite ?? false,
				addedBy: entry?.addedBy ?? '',
				addedAt: entry?.addedAt ?? '',
				/** No access record — seen via usage only (admitted by a policy). */
				unlisted: !entry,
				envAdmin: isEnvAdmin(username),
				usage,
				// Which policies this user's requests matched this month (names).
				policyNames: Object.keys(usage.monthByPolicy)
					.map((id) => policies.find((p) => p.id === id)?.name)
					.filter((n): n is string => Boolean(n))
			};
		})
	);
	list.sort((a, b) => a.username.localeCompare(b.username));

	// Aggregate per-tag usage across users. Names resolve against the CURRENT
	// department/policy lists; usage of deleted ones is dropped from the cards.
	const sumTag = (pick: (u: (typeof list)[number]) => Record<string, number>) => {
		const acc: Record<string, number> = {};
		for (const u of list)
			for (const [id, w] of Object.entries(pick(u))) acc[id] = (acc[id] ?? 0) + w;
		return acc;
	};
	const deptMonth = sumTag((u) => u.usage.monthByDept);
	const deptToday = sumTag((u) => u.usage.todayByDept);
	const policyMonth = sumTag((u) => u.usage.monthByPolicy);
	const deptUsage = departments
		.map((d) => ({ id: d.id, name: d.name, today: deptToday[d.id] ?? 0, month: deptMonth[d.id] ?? 0 }))
		.filter((d) => d.month > 0)
		.sort((a, b) => b.month - a.month);
	const policyUsage = policies
		.map((p) => ({ id: p.id, name: p.name, month: policyMonth[p.id] ?? 0 }))
		.filter((p) => p.month > 0)
		.sort((a, b) => b.month - a.month);

	// Org-wide daily series, last 30 days (zeros filled) for the usage chart.
	const dayTotals: Record<string, number> = {};
	for (const u of list)
		for (const [day, w] of Object.entries(u.usage.days)) dayTotals[day] = (dayTotals[day] ?? 0) + w;
	const daily = Array.from({ length: 30 }, (_, i) => {
		const day = new Date(Date.now() - (29 - i) * 86_400_000).toISOString().slice(0, 10);
		return { day, weighted: dayTotals[day] ?? 0 };
	});

	return json({
		users: list,
		policies,
		deptUsage,
		policyUsage,
		daily,
		openMode: await isOpenMode(),
		// The caller's own claims, so the console can preview "matches you".
		you: { claims: profileClaims(admin.profile) }
	});
};

/** Replace the access-policy list wholesale (the console edits it as one doc). */
export const PUT: RequestHandler = async ({ request }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;

	const body = await request.json().catch(() => ({}));
	if (!Array.isArray(body.policies)) {
		return json({ error: 'Expected { policies: [] }' }, { status: 400 });
	}
	const saved = await setPolicies(body.policies);
	logAudit({
		actor: admin.username,
		via: 'session',
		...requestMeta(request),
		category: 'admin',
		action: 'policies.save',
		status: 'ok',
		detail: { count: saved.length, names: saved.map((p) => p.name) }
	});
	return json({ policies: saved });
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
	logAudit({
		actor: admin.username,
		via: 'session',
		...requestMeta(request),
		category: 'admin',
		action: 'user.add',
		target: body.username.trim().toLowerCase(),
		status: 'ok'
	});
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
	logAudit({
		actor: admin.username,
		via: 'session',
		...requestMeta(request),
		category: 'admin',
		action: 'user.patch',
		target: body.username.trim().toLowerCase(),
		status: 'ok',
		detail: patch as Record<string, unknown>
	});
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
	logAudit({
		actor: admin.username,
		via: 'session',
		...requestMeta(request),
		category: 'admin',
		action: 'user.remove',
		target: username.toLowerCase(),
		status: 'ok'
	});
	return json({ ok: true });
};

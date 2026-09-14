import { json } from '@sveltejs/kit';
import { authenticateRequest, type AuthUser } from '$lib/server/auth';
import { getCapabilities, resolveRole } from '$lib/server/access';
import { listSandboxes, removeSandboxByName, stopSandboxByName } from '$lib/server/sandbox';
import { listConversations } from '$lib/server/conversations';
import { logAudit, requestMeta } from '$lib/server/audit';
import type { RequestHandler } from './$types';

/** Console → Sandboxes: the microVMs this deployment owns. Admin-only. */
async function requireAdmin(request: Request): Promise<AuthUser | Response> {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	if ((await resolveRole(user.username, user.profile)) !== 'admin')
		return json({ error: 'Forbidden' }, { status: 403 });
	return user;
}

/**
 * Snapshot of every VM plus point-in-time metrics for the running ones. The
 * console polls this while the section is open; the SDK is only touched when
 * the capability is on, so hosts without KVM never load the native module.
 */
export const GET: RequestHandler = async ({ request }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;
	if (!(await getCapabilities()).codeExecution) {
		return json({ enabled: false, backend: null, sandboxes: [] });
	}
	try {
		const { backend, sandboxes } = await listSandboxes();
		// Conversation titles, one index read per distinct owner.
		const titles = new Map<string, string>();
		const owners = [...new Set(sandboxes.map((s) => s.user).filter((u): u is string => !!u))];
		await Promise.all(
			owners.map(async (u) => {
				for (const c of await listConversations(u).catch(() => [])) titles.set(`${u}:${c.id}`, c.title);
			})
		);
		return json({
			enabled: true,
			backend,
			sandboxes: sandboxes.map((s) => ({
				...s,
				conversationTitle:
					s.user && s.conversationId ? (titles.get(`${s.user}:${s.conversationId}`) ?? null) : null
			}))
		});
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'sandbox runtime unavailable' },
			{ status: 503 }
		);
	}
};

/** `{ action: 'stop' | 'remove', name }` — audited; only `pai-*` names are accepted. */
export const POST: RequestHandler = async ({ request }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;

	const body = await request.json().catch(() => ({}));
	const name = typeof body.name === 'string' ? body.name : '';
	const action = body.action === 'stop' || body.action === 'remove' ? body.action : null;
	if (!name || !action) return json({ error: 'Expected { action, name }' }, { status: 400 });

	try {
		if (action === 'stop') await stopSandboxByName(name);
		else await removeSandboxByName(name);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'sandbox action failed';
		logAudit({
			actor: admin.username,
			via: 'session',
			...requestMeta(request),
			category: 'admin',
			action: `sandbox.${action}`,
			target: name,
			status: 'error',
			detail: { error: message.slice(0, 200) }
		});
		return json({ error: message }, { status: 400 });
	}
	logAudit({
		actor: admin.username,
		via: 'session',
		...requestMeta(request),
		category: 'admin',
		action: `sandbox.${action}`,
		target: name,
		status: 'ok'
	});
	return json({ ok: true });
};

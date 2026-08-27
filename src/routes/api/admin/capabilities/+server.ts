import { json } from '@sveltejs/kit';
import { authenticateRequest, type AuthUser } from '$lib/server/auth';
import { getCapabilities, resolveRole, setCapabilities } from '$lib/server/access';
import { testSandbox, warmSandbox } from '$lib/server/sandbox';
import { logAudit, requestMeta } from '$lib/server/audit';
import type { RequestHandler } from './$types';

/** Deployment-wide feature switches (console → Capacidades). Admin-only. */
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
	return json({ capabilities: await getCapabilities() });
};

export const PATCH: RequestHandler = async ({ request }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;

	const body = await request.json().catch(() => ({}));
	const patch: { codeExecution?: boolean } = {};
	if (typeof body.codeExecution === 'boolean') patch.codeExecution = body.codeExecution;
	const capabilities = await setCapabilities(patch);
	// Enabling code execution kicks the warm-up immediately, so the image pull
	// happens now (visible to the admin via Testar) — never on a user's turn.
	if (patch.codeExecution === true) warmSandbox();
	logAudit({
		actor: admin.username,
		via: 'session',
		...requestMeta(request),
		category: 'admin',
		action: 'capability.update',
		status: 'ok',
		detail: patch as Record<string, unknown>
	});
	return json({ capabilities });
};

/** Health probe: boots a microVM, runs a computation, tears it down. */
export const POST: RequestHandler = async ({ request }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;
	return json(await testSandbox());
};

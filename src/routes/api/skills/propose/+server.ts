import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import { departmentsForUser } from '$lib/server/access';
import { deptSkillScope, proposeSkill } from '$lib/server/skills';
import { logAudit, requestMeta } from '$lib/server/audit';
import type { RequestHandler } from './$types';

/**
 * Share a personal skill from Settings: propose it into a shared scope for
 * admin review — the UI counterpart of the agent's proposeSkill tool, with the
 * same rule: a user can only target the organization or departments THEY match.
 */

export const GET: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	return json({
		departments: (await departmentsForUser(user.profile)).map((d) => ({ id: d.id, name: d.name }))
	});
};

export const POST: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	const body = await request.json().catch(() => ({}));
	const id = typeof body.id === 'string' ? body.id : '';
	const scope = typeof body.scope === 'string' ? body.scope : '';
	if (!id || !scope) return json({ error: 'id and scope are required' }, { status: 400 });

	const depts = await departmentsForUser(user.profile);
	const target =
		scope === 'org' ? 'org' : depts.some((d) => d.id === scope) ? deptSkillScope(scope) : null;
	if (!target) return json({ error: 'invalid scope' }, { status: 400 });

	const result = await proposeSkill(user.username, id, target);
	if (!result.ok) {
		return json(
			{ error: result.reason === 'duplicate' ? 'duplicate' : 'not_found' },
			{ status: result.reason === 'duplicate' ? 409 : 404 }
		);
	}
	logAudit({
		actor: user.username,
		via: 'session',
		...requestMeta(request),
		category: 'admin',
		action: 'skill.propose',
		target: id,
		status: 'ok',
		detail: { scope }
	});
	return json({ ok: true });
};

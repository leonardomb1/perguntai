import { json } from '@sveltejs/kit';
import { authenticateRequest, type AuthUser } from '$lib/server/auth';
import { getDepartments, resolveRole } from '$lib/server/access';
import {
	deptSkillScope,
	listSharedSkills,
	orgSkillScope,
	removeSharedSkill,
	setSharedSkillEnabled
} from '$lib/server/skills';
import { logAudit, requestMeta } from '$lib/server/audit';
import type { RequestHandler } from './$types';

/**
 * Shared-skill governance (console → Habilidades). The agent can only PROPOSE
 * into shared scopes (enabled:false); this is where an admin approves,
 * suspends or removes — every action audited.
 */
async function requireAdmin(request: Request): Promise<AuthUser | Response> {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	if ((await resolveRole(user.username, user.profile)) !== 'admin')
		return json({ error: 'Forbidden' }, { status: 403 });
	return user;
}

/** A scope must be 'org' or an existing department id. */
async function resolveScope(raw: unknown): Promise<{ scope: string; label: string } | null> {
	if (raw === 'org') return { scope: orgSkillScope, label: 'org' };
	if (typeof raw !== 'string' || !raw) return null;
	const dept = (await getDepartments()).find((d) => d.id === raw);
	return dept ? { scope: deptSkillScope(dept.id), label: dept.name } : null;
}

export const GET: RequestHandler = async ({ request }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;
	const departments = await getDepartments();
	return json({
		org: await listSharedSkills(orgSkillScope, { includeDisabled: true }),
		departments: await Promise.all(
			departments.map(async (d) => ({
				id: d.id,
				name: d.name,
				skills: await listSharedSkills(deptSkillScope(d.id), {
					includeDisabled: true
				})
			}))
		)
	});
};

// Approve or suspend: { scope: 'org' | <deptId>, id, enabled }
export const PATCH: RequestHandler = async ({ request }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;
	const body = await request.json().catch(() => ({}));
	const target = await resolveScope(body.scope);
	if (!target || typeof body.id !== 'string' || typeof body.enabled !== 'boolean') {
		return json({ error: 'scope, id and enabled are required' }, { status: 400 });
	}
	const ok = await setSharedSkillEnabled(target.scope, body.id, body.enabled);
	if (!ok) return json({ error: 'Not found' }, { status: 404 });
	logAudit({
		actor: admin.username,
		via: 'session',
		...requestMeta(request),
		category: 'admin',
		action: body.enabled ? 'skill.approve' : 'skill.suspend',
		target: body.id,
		status: 'ok',
		detail: { scope: target.label }
	});
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ request, url }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;
	const target = await resolveScope(url.searchParams.get('scope'));
	const id = url.searchParams.get('id');
	if (!target || !id) return json({ error: 'scope and id are required' }, { status: 400 });
	const ok = await removeSharedSkill(target.scope, id);
	if (!ok) return json({ error: 'Not found' }, { status: 404 });
	logAudit({
		actor: admin.username,
		via: 'session',
		...requestMeta(request),
		category: 'admin',
		action: 'skill.remove',
		target: id,
		status: 'ok',
		detail: { scope: target.label }
	});
	return json({ ok: true });
};

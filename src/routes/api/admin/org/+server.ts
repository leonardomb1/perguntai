import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import {
	getDepartments,
	getOrgKnowledge,
	getOrgSystemPrompt,
	resolveRole,
	setDepartments,
	setOrgKnowledge,
	setOrgSystemPrompt
} from '$lib/server/access';
import type { RequestHandler } from './$types';

/**
 * The organization knowledge base — a free-text standing prompt, structured
 * company knowledge blocks, and department-scoped knowledge (injected only for
 * matching users) — all injected into every user's agent. Admin-only; the model
 * may propose entries in chat but never writes this store.
 *
 * GET also returns the calling admin's own directory signals (AD groups, cost
 * center) so the console can seed the department rule editor and show a live
 * "matches you" check — the server has no user-profile store, so the caller's
 * own token is the only membership sample it can offer.
 */

export const GET: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user || (await resolveRole(user.username)) !== 'admin')
		return json({ error: 'Forbidden' }, { status: 403 });
	return json({
		orgSystemPrompt: await getOrgSystemPrompt(),
		orgKnowledge: await getOrgKnowledge(),
		departments: await getDepartments(),
		you: {
			memberOf: user.profile?.memberOf ?? [],
			costCenterCode: user.profile?.costCenterCode ?? null,
			costCenterDescription: user.profile?.costCenterDescription ?? null
		}
	});
};

export const PUT: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user || (await resolveRole(user.username)) !== 'admin')
		return json({ error: 'Forbidden' }, { status: 403 });
	const body = await request.json().catch(() => ({}));
	if (typeof body.orgSystemPrompt === 'string') await setOrgSystemPrompt(body.orgSystemPrompt);
	if (body.orgKnowledge !== undefined) await setOrgKnowledge(body.orgKnowledge);
	if (body.departments !== undefined) await setDepartments(body.departments);
	return json({
		orgSystemPrompt: await getOrgSystemPrompt(),
		orgKnowledge: await getOrgKnowledge(),
		departments: await getDepartments()
	});
};

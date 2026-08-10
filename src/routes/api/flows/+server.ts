import { json } from '@sveltejs/kit';
import { requireBuilder } from '$lib/server/guards';
import { listAllFlows, resolveFlowAccess } from '$lib/server/flows';
import { departmentsForUser, getDepartments, resolveRole } from '$lib/server/access';
import type { FlowListItem } from '$lib/flow-spec';
import type { RequestHandler } from './$types';

/**
 * Flow listing, scoped by department. Admins see every flow (including orphaned
 * ones with no department); everyone else sees the flows they own plus those in
 * a department they belong to. Each row carries the caller's access level and a
 * department label so the UI can group and gate.
 */
export const GET: RequestHandler = async ({ request }) => {
	const user = await requireBuilder(request);
	if (user instanceof Response) return user;

	const role = await resolveRole(user.username);
	const all = await listAllFlows();
	const matched = new Set((await departmentsForUser(user.profile)).map((d) => d.id));
	const deptName = new Map((await getDepartments()).map((d) => [d.id, d.name]));

	const flows: FlowListItem[] = all
		.map((m) => ({
			...m,
			access: resolveFlowAccess(m, user.username, role, matched),
			departmentName: m.departmentId ? (deptName.get(m.departmentId) ?? null) : null,
			orphaned: m.departmentId === null
		}))
		.filter((m) => m.access !== 'none');

	return json({ flows });
};

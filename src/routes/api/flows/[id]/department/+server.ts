import { json } from '@sveltejs/kit';
import { requireFlowAccess } from '$lib/server/guards';
import { assignDepartment, publicRecord } from '$lib/server/flows';
import { departmentsForUser, getDepartments } from '$lib/server/access';
import type { RequestHandler } from './$types';

/**
 * Assign or reassign a flow's department (also how admins triage orphans).
 * Owners may move a flow among departments THEY belong to; admins may set any
 * department (or null to orphan).
 */
export const PUT: RequestHandler = async ({ request, params }) => {
	const ctx = await requireFlowAccess(request, params.id, 'edit');
	if (ctx instanceof Response) return ctx;

	const body = (await request.json().catch(() => ({}))) as { departmentId?: string | null };
	const departmentId = typeof body.departmentId === 'string' ? body.departmentId : null;

	if (departmentId !== null) {
		// Target must exist…
		if (!(await getDepartments()).some((d) => d.id === departmentId))
			return json({ error: 'unknown_department' }, { status: 400 });
		// …and a non-admin may only assign to a department they belong to.
		if (ctx.access !== 'admin') {
			const mine = await departmentsForUser(ctx.user.profile);
			if (!mine.some((d) => d.id === departmentId))
				return json({ error: 'Forbidden' }, { status: 403 });
		}
	} else if (ctx.access !== 'admin') {
		// Only admins may orphan a flow (leave it without a department).
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const updated = await assignDepartment(params.id, departmentId);
	if (!updated) return json({ error: 'Flow not found' }, { status: 404 });
	return json({ ...publicRecord(updated), access: ctx.access });
};

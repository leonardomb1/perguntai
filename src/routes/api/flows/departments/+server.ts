import { json } from '@sveltejs/kit';
import { requireBuilder } from '$lib/server/guards';
import { departmentsForUser, getDepartments, resolveRole } from '$lib/server/access';
import type { RequestHandler } from './$types';

/**
 * The departments the caller may assign a flow to: admins get every department,
 * builders get the ones they belong to (matched from their token profile). Used
 * by the builder page's new-flow department picker and the reassign control.
 */
export const GET: RequestHandler = async ({ request }) => {
	const user = await requireBuilder(request);
	if (user instanceof Response) return user;
	const role = await resolveRole(user.username);
	const list = role === 'admin' ? await getDepartments() : await departmentsForUser(user.profile);
	return json({ departments: list.map((d) => ({ id: d.id, name: d.name })) });
};

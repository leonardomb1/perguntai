import { json } from '@sveltejs/kit';
import { deleteFlow, publicRecord } from '$lib/server/flows';
import { requireFlowAccess } from '$lib/server/guards';
import { getUserSettings } from '$lib/server/settings';
import {
	deleteWindmillFlow,
	deleteWindmillSchedule,
	deleteWindmillVariable
} from '$lib/server/windmill';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request, params }) => {
	const ctx = await requireFlowAccess(request, params.id, 'view');
	if (ctx instanceof Response) return ctx;
	return json({ ...publicRecord(ctx.record), access: ctx.access });
};

export const DELETE: RequestHandler = async ({ request, params }) => {
	const ctx = await requireFlowAccess(request, params.id, 'edit');
	if (ctx instanceof Response) return ctx;
	const { record } = ctx;

	// Best-effort Windmill cleanup with the OWNER's deploy token (an admin may be
	// deleting someone else's flow). A missing token must not block the delete.
	if (record.deployment) {
		const token = (await getUserSettings(record.owner)).windmillDeployToken;
		if (token) {
			const path = record.deployment.windmillPath;
			await deleteWindmillSchedule(token, path).catch(() => {});
			await deleteWindmillFlow(token, path).catch(() => {});
			await Promise.all(
				['_sr_user', '_sr_pass', '_secret'].map((suffix) =>
					deleteWindmillVariable(token, `${path}${suffix}`).catch(() => {})
				)
			);
		}
	}

	await deleteFlow(record.owner, params.id);
	return json({ ok: true });
};

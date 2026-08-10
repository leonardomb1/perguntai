import { json } from '@sveltejs/kit';
import { requireFlowAccess } from '$lib/server/guards';
import { clearDeployment, publicRecord } from '$lib/server/flows';
import { getUserSettings } from '$lib/server/settings';
import {
	deleteWindmillFlow,
	deleteWindmillSchedule,
	deleteWindmillVariable
} from '$lib/server/windmill';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, params }) => {
	const ctx = await requireFlowAccess(request, params.id, 'edit');
	if (ctx instanceof Response) return ctx;
	const { record } = ctx;
	if (!record.deployment) return json(publicRecord(record));

	// Uses the OWNER's stored deploy token (an admin may be deactivating someone
	// else's flow).
	const token = (await getUserSettings(record.owner)).windmillDeployToken;
	if (!token) return json({ error: 'needs_deploy_token' }, { status: 400 });
	const path = record.deployment.windmillPath;
	// Best-effort cleanup: each delete ignores 404s internally.
	await deleteWindmillSchedule(token, path);
	await deleteWindmillFlow(token, path);
	await Promise.all(
		['_sr_user', '_sr_pass', '_secret'].map((suffix) =>
			deleteWindmillVariable(token, `${path}${suffix}`)
		)
	);

	const updated = await clearDeployment(record.owner, record.id);
	return json(publicRecord(updated ?? record));
};

import { json } from '@sveltejs/kit';
import { requireFlowAccess } from '$lib/server/guards';
import { getUserSettings } from '$lib/server/settings';
import { listFlowRuns } from '$lib/server/windmill';
import type { RequestHandler } from './$types';

/** Recent Windmill runs of the deployed flow (schedule ticks + manual). */
export const GET: RequestHandler = async ({ request, params }) => {
	const ctx = await requireFlowAccess(request, params.id, 'view');
	if (ctx instanceof Response) return ctx;
	const { record } = ctx;
	if (!record.deployment) return json({ runs: [] });

	const token = (await getUserSettings(record.owner)).windmillDeployToken;
	if (!token) return json({ runs: [] });

	try {
		const runs = await listFlowRuns(token, record.deployment.windmillPath);
		return json({ runs });
	} catch {
		return json({ runs: [] });
	}
};

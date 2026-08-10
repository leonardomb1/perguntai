import { json } from '@sveltejs/kit';
import { requireFlowAccess } from '$lib/server/guards';
import { getUserSettings } from '$lib/server/settings';
import { runWindmillFlow } from '$lib/server/windmill';
import type { RequestHandler } from './$types';

/** Fire the DEPLOYED version now (manual trigger / test run). Any viewer may run
 *  it; it executes under the OWNER's stored token and sealed credentials. */
export const POST: RequestHandler = async ({ request, params }) => {
	const ctx = await requireFlowAccess(request, params.id, 'run');
	if (ctx instanceof Response) return ctx;
	const { record } = ctx;
	if (!record.deployment) return json({ error: 'Flow is not active' }, { status: 409 });

	const token = (await getUserSettings(record.owner)).windmillDeployToken;
	if (!token) return json({ error: 'needs_deploy_token' }, { status: 400 });

	try {
		const jobId = await runWindmillFlow(token, record.deployment.windmillPath);
		return json({ jobId });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Run failed';
		return json({ error: message.slice(0, 300) }, { status: 502 });
	}
};

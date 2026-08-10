import { json } from '@sveltejs/kit';
import { requireFlowAccess } from '$lib/server/guards';
import { listTraces } from '$lib/server/flow-traces';
import type { RequestHandler } from './$types';

/** Agent-step traces of recent runs — the UI matches them to runs by jobId. */
export const GET: RequestHandler = async ({ request, params }) => {
	const ctx = await requireFlowAccess(request, params.id, 'view');
	if (ctx instanceof Response) return ctx;
	return json({ traces: await listTraces(ctx.record.owner, params.id) });
};

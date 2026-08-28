import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import { getCapabilities } from '$lib/server/access';
import { listRuns, listSchedules } from '$lib/server/schedules';
import { executeSchedule } from '$lib/server/scheduler';
import type { RequestHandler } from './$types';

/** Run history for one schedule; POST fires an immediate run ("Executar agora"). */

export const GET: RequestHandler = async ({ request, params }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	return json({ runs: await listRuns(user.username, params.id) });
};

export const POST: RequestHandler = async ({ request, params }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (!(await getCapabilities()).scheduledRuns) {
		return json({ error: 'Scheduled runs are not enabled' }, { status: 404 });
	}
	const schedule = (await listSchedules(user.username)).find((s) => s.id === params.id);
	if (!schedule) return json({ error: 'Not found' }, { status: 404 });
	// Synchronous on purpose: the button shows a spinner and the fresh run
	// appears in the history the moment this returns.
	const run = await executeSchedule(user.username, schedule);
	return json({ run });
};

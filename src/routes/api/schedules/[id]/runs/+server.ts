import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import { getCapabilities } from '$lib/server/access';
import { listRuns, listSchedules } from '$lib/server/schedules';
import { startScheduleRun } from '$lib/server/scheduler';
import type { RequestHandler } from './$types';

/** Run history for one schedule; POST fires an immediate run. */

export const GET: RequestHandler = async ({ request, params }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	return json({ runs: await listRuns(user.username, params.id) });
};

/**
 * "Executar agora": starts the run as a CONVERSATION (see startScheduleRun)
 * and returns its pointer immediately — the client navigates to the
 * conversation and watches it live through the normal resumable chat stream.
 * The run itself is server-owned: navigating away never stops it.
 */
export const POST: RequestHandler = async ({ request, params }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (!(await getCapabilities()).scheduledRuns) {
		return json({ error: 'Scheduled runs are not enabled' }, { status: 404 });
	}
	const schedule = (await listSchedules(user.username)).find((s) => s.id === params.id);
	if (!schedule) return json({ error: 'Not found' }, { status: 404 });

	try {
		const { run } = await startScheduleRun(user.username, schedule);
		return json({ run }, { status: 202 });
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'could not start run' },
			{ status: 429 }
		);
	}
};

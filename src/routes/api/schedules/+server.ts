import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import { getCapabilities } from '$lib/server/access';
import { listRuns, listSchedules, removeSchedule, saveSchedule } from '$lib/server/schedules';
import { deleteConversation } from '$lib/server/conversations';
import { logAudit, requestMeta } from '$lib/server/audit';
import type { RequestHandler } from './$types';

/**
 * Programado management — user-owned, like conversations: the caller only
 * ever sees and edits their OWN schedules.
 */

export const GET: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	return json({
		enabled: (await getCapabilities()).scheduledRuns,
		schedules: await listSchedules(user.username)
	});
};

// Create (no id) or update (id given).
export const POST: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (!(await getCapabilities()).scheduledRuns) {
		return json({ error: 'Scheduled runs are not enabled' }, { status: 404 });
	}
	const body = await request.json().catch(() => ({}));
	const result = await saveSchedule(user.username, {
		id: typeof body.id === 'string' ? body.id : undefined,
		title: typeof body.title === 'string' ? body.title : undefined,
		instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
		frequency: body.frequency,
		time: typeof body.time === 'string' ? body.time : undefined,
		weekday: typeof body.weekday === 'number' ? body.weekday : undefined,
		dayOfMonth: typeof body.dayOfMonth === 'number' ? body.dayOfMonth : undefined,
		enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined
	});
	if (!result.ok) return json({ error: result.reason }, { status: 400 });
	logAudit({
		actor: user.username,
		via: 'session',
		...requestMeta(request),
		category: 'chat',
		action: body.id ? 'schedule.update' : 'schedule.create',
		target: result.schedule.title,
		status: 'ok'
	});
	return json({ schedule: result.schedule });
};

export const DELETE: RequestHandler = async ({ request, url }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	const id = url.searchParams.get('id');
	if (!id) return json({ error: 'Missing id' }, { status: 400 });
	// Cascade: run transcripts live in the conversation store.
	for (const run of await listRuns(user.username, id)) {
		if (run.conversationId) await deleteConversation(user.username, run.conversationId).catch(() => {});
	}
	const removed = await removeSchedule(user.username, id);
	if (!removed) return json({ error: 'Not found' }, { status: 404 });
	logAudit({
		actor: user.username,
		via: 'session',
		...requestMeta(request),
		category: 'chat',
		action: 'schedule.delete',
		target: id,
		status: 'ok'
	});
	return json({ ok: true });
};

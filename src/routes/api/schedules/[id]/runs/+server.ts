import { json } from '@sveltejs/kit';
import { createAgentUIStreamResponse } from 'ai';
import { authenticateRequest } from '$lib/server/auth';
import { getCapabilities } from '$lib/server/access';
import { listRuns, listSchedules, type ScheduleRun } from '$lib/server/schedules';
import {
	buildScheduleAgent,
	finishScheduleRun,
	schedulePrompt,
	SCHEDULE_MAX_STEPS,
	SCHEDULE_RUN_TIMEOUT_MS,
	TRUNCATION_NOTE
} from '$lib/server/scheduler';
import { weightedTokens } from '$lib/server/usage';
import { withHeartbeat } from '$lib/server/heartbeat';
import type { RequestHandler } from './$types';

/** Run history for one schedule; POST fires an immediate run and STREAMS it. */

export const GET: RequestHandler = async ({ request, params }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	return json({ runs: await listRuns(user.username, params.id) });
};

/**
 * "Executar agora": the same headless run the sweep performs, but returned as
 * a live UI-message stream so the pane shows reasoning and tool calls as they
 * happen. The run is NOT tied to the socket — navigating away lets it finish
 * server-side, and the result still lands in the history (finishScheduleRun
 * runs in onFinish either way).
 */
export const POST: RequestHandler = async ({ request, params }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (!(await getCapabilities()).scheduledRuns) {
		return json({ error: 'Scheduled runs are not enabled' }, { status: 404 });
	}
	const schedule = (await listSchedules(user.username)).find((s) => s.id === params.id);
	if (!schedule) return json({ error: 'Not found' }, { status: 404 });

	const startedAt = new Date().toISOString();
	const startedMs = Date.now();
	let totalTokens = 0;
	let stepCount = 0;
	const toolsUsed = new Set<string>();
	let finalText = '';
	let streamError: string | null = null;

	let built;
	try {
		built = await buildScheduleAgent(user.username, schedule);
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'could not start run' },
			{ status: 429 }
		);
	}
	const { agent, mcp } = built;

	// Bounded by its own timer, never by the client connection.
	const abort = new AbortController();
	const timeout = setTimeout(() => abort.abort(), SCHEDULE_RUN_TIMEOUT_MS);

	return withHeartbeat(
		await createAgentUIStreamResponse({
			agent,
			uiMessages: [
				{
					id: crypto.randomUUID(),
					role: 'user' as const,
					parts: [{ type: 'text' as const, text: schedulePrompt(schedule) }]
				}
			],
			abortSignal: abort.signal,
			onStepEnd: (event) => {
				stepCount += 1;
				totalTokens += weightedTokens(event.usage);
				const e = event as { toolCalls?: { toolName?: string }[]; text?: string };
				for (const call of e.toolCalls ?? []) {
					if (call.toolName) toolsUsed.add(call.toolName);
				}
				if (typeof e.text === 'string' && e.text.trim()) finalText = e.text;
			},
			onFinish: async () => {
				clearTimeout(timeout);
				await mcp.close().catch(() => {});
				const run: ScheduleRun = {
					id: crypto.randomUUID(),
					startedAt,
					finishedAt: new Date().toISOString(),
					status: streamError ? 'error' : 'ok',
					text: finalText + (stepCount >= SCHEDULE_MAX_STEPS && !streamError ? TRUNCATION_NOTE : ''),
					tools: [...toolsUsed],
					tokens: Math.round(totalTokens),
					...(streamError ? { error: streamError } : {})
				};
				await finishScheduleRun(user.username, schedule, run, startedMs).catch((e) =>
					console.error('schedule run persistence failed:', e)
				);
			},
			onError: (error) => {
				console.error('schedule run stream error:', error);
				streamError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
				return streamError.slice(0, 300);
			}
		})
	);
};

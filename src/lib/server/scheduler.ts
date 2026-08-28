import { readUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import { buildAgent } from './agent';
import { connectMcpTools } from './mcp';
import { saveConversation } from './conversations';
import { beginRun, liveStreamKey, recordStream } from './live-streams';
import { getUserSettings } from './settings';
import { getCapabilities, getEffectiveOrgPrompt, resolveDailyLimit, resolveModel } from './access';
import { addUsage, usageToday, weightedTokens } from './usage';
import { logAudit } from './audit';
import {
	appendRun,
	isDue,
	listSchedules,
	markRan,
	scheduleOwners,
	updateRun,
	type Schedule,
	type ScheduleRun
} from './schedules';
import type { AuthUser } from './auth';

/**
 * The Programado runner: a single in-process sweep (this deployment is one
 * container — no distributed locking needed) that fires due schedules as
 * HEADLESS agent runs. The owner is not logged in: warehouse access rides on
 * the stored credential (credentialStore/oidcStore — the same path API keys
 * use), runs are charged against the owner's daily token budget, capped in
 * steps, audited, and their final answer lands in the run history.
 */

const SWEEP_MS = 60_000;
/** At most this many runs per sweep — a backlog drains over minutes, not at once. */
const MAX_RUNS_PER_SWEEP = 3;
/** Step budget for scheduled runs — a full report + PDF + e-mail pipeline
 *  routinely passes chat's 24. */
export const SCHEDULE_MAX_STEPS = 60;
/** Appended to a run's text when a cap cut the loop mid-work — without it the
 *  history shows a mid-sentence "final" answer and nobody knows why. */
export const TRUNCATION_NOTE =
	'\n\n---\n⚠️ *Execução interrompida no limite de passos — o relatório acima está incompleto. Considere dividir as instruções em agendamentos menores.*';

let started = false;
let sweeping = false;

export function startScheduler(): void {
	// Guard double-starts (dev HMR re-imports modules).
	const g = globalThis as { __perguntaiScheduler?: boolean };
	if (started || g.__perguntaiScheduler) return;
	g.__perguntaiScheduler = true;
	started = true;
	setInterval(() => void sweep(), SWEEP_MS).unref();
}

async function sweep(): Promise<void> {
	if (sweeping) return;
	sweeping = true;
	try {
		if (!(await getCapabilities()).scheduledRuns) return;
		const now = new Date();
		let fired = 0;
		for (const owner of await scheduleOwners()) {
			for (const schedule of await listSchedules(owner)) {
				if (fired >= MAX_RUNS_PER_SWEEP) return;
				if (!isDue(schedule, now)) continue;
				fired++;
				// Mark BEFORE running: a crash mid-run must not replay the slot
				// forever, and the run itself lands in history either way.
				await markRan(owner, schedule.id, now.toISOString());
				await executeSchedule(owner, schedule).catch((e) =>
					console.error(`scheduler: run failed for ${owner}/${schedule.title}:`, e)
				);
			}
		}
	} catch (error) {
		console.error('scheduler sweep failed:', error);
	} finally {
		sweeping = false;
	}
}

/** The headless prompt wrapper both run paths share. */
export function schedulePrompt(schedule: Schedule): string {
	return (
		`[Scheduled run] These are the user's standing instructions, executed automatically on a schedule — ` +
		`they are not present to answer questions, so state assumptions instead of asking. If the ` +
		`instructions name e-mail recipients, that IS their explicit request to send. Finish with a ` +
		`concise report of what you did and found.\n\n${schedule.instructions}`
	);
}

/**
 * Everything a headless run needs: owner-budget check (throws when spent),
 * the user's MCP connections, and the agent (mode 'api', stable
 * pseudo-conversation id so sandbox workspace files persist across runs).
 * Caller MUST close mcp when done.
 */
export async function buildScheduleAgent(username: string, schedule: Schedule) {
	const dailyLimit = await resolveDailyLimit(username, undefined);
	let tokenBudget: number | null = null;
	if (dailyLimit) {
		const used = await usageToday(username);
		if (used >= dailyLimit) throw new Error('daily token limit reached');
		tokenBudget = dailyLimit - used;
	}

	const user: AuthUser = {
		username,
		displayName: null,
		credentials: { username }
	} as AuthUser;
	const settings = await getUserSettings(username);
	const mcp = await connectMcpTools(settings.mcpServers.filter((sv) => sv.enabled));
	const agent = await buildAgent(
		user,
		settings,
		mcp.tools,
		`sched-${schedule.id}`,
		await getEffectiveOrgPrompt(),
		tokenBudget,
		await resolveModel(username, '', undefined),
		'api',
		SCHEDULE_MAX_STEPS
	);
	return { agent, mcp };
}

/**
 * Starts one run AS A CONVERSATION: the transcript streams into the regular
 * conversation store and the live-streams registry, so ChatPane can watch it
 * live (and reattach after navigation) exactly like a normal chat, and the
 * user can keep talking to the finished run afterwards — fixing a failed run
 * where it stopped instead of re-running from scratch.
 *
 * Returns immediately with the run pointer; `done` resolves when the run
 * finishes (the sweep awaits it to bound concurrency, the run-now endpoint
 * does not).
 */
export async function startScheduleRun(
	username: string,
	schedule: Schedule
): Promise<{ run: ScheduleRun; done: Promise<void> }> {
	const startedAt = new Date().toISOString();
	const startedMs = Date.now();
	const runId = crypto.randomUUID();
	// Valid conversation id ([A-Za-z0-9-], ≤64): sched- + uuid + base36 time.
	const conversationId = `sched-${schedule.id}-${Date.now().toString(36)}`;
	const prompt = schedulePrompt(schedule);

	const userMessage: UIMessage = {
		id: crypto.randomUUID(),
		role: 'user',
		parts: [{ type: 'text', text: prompt }]
	};
	const title = `${schedule.title} — ${new Date().toLocaleString('pt-BR', {
		day: '2-digit',
		month: '2-digit',
		hour: '2-digit',
		minute: '2-digit'
	})}`;
	await saveConversation(username, conversationId, [userMessage], title);

	const run: ScheduleRun = {
		id: runId,
		startedAt,
		finishedAt: '',
		status: 'running',
		text: '',
		tools: [],
		tokens: 0,
		conversationId
	};
	await appendRun(username, schedule.id, run);

	const done = (async () => {
		let totalTokens = 0;
		let stepCount = 0;
		const toolsUsed = new Set<string>();
		let assistantMessage: UIMessage | undefined;
		let failure: string | null = null;

		try {
			const { agent, mcp } = await buildScheduleAgent(username, schedule);
			try {
				// Same resumable-run registration as chat: the signal fires on
				// explicit stop or the run timeout, never on client disconnects.
				// beginRun's registry enforces the 20-min hard cap; the schedule's
				// own step budget (SCHEDULE_MAX_STEPS) bounds the loop before that.
				const signal = beginRun(username, conversationId);
				const result = agent.stream({
					messages: [{ role: 'user' as const, content: prompt }],
					abortSignal: signal,
					onStepFinish: (step: {
						usage?: Parameters<typeof weightedTokens>[0];
						toolCalls?: { toolName?: string }[];
					}) => {
						stepCount += 1;
						totalTokens += weightedTokens(step.usage);
						for (const call of step.toolCalls ?? []) {
							if (call.toolName) toolsUsed.add(call.toolName);
						}
					}
				});
				const streamResult = await result;
				const uiStream = streamResult.toUIMessageStream();
				const [forResume, forCapture] = uiStream.tee();

				// Feed the resumable buffer — GET /api/chat/{id}/stream replays it.
				recordStream(
					liveStreamKey(username, conversationId),
					createUIMessageStreamResponse({ stream: forResume })
				);

				// Capture the final assistant UIMessage (reasoning + tool parts
				// included) for the server-side conversation save.
				for await (const message of readUIMessageStream({ stream: forCapture })) {
					assistantMessage = message as UIMessage;
				}
			} finally {
				await mcp.close().catch(() => {});
			}
		} catch (error) {
			failure = error instanceof Error ? error.message.slice(0, 500) : 'run failed';
		}

		const finalText = assistantMessage
			? assistantMessage.parts
					.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
					.map((part) => part.text)
					.join('\n')
			: '';
		const truncated = stepCount >= SCHEDULE_MAX_STEPS && !failure;

		const messages = assistantMessage ? [userMessage, assistantMessage] : [userMessage];
		await saveConversation(username, conversationId, messages, title).catch(() => {});

		const finished: ScheduleRun = {
			...run,
			finishedAt: new Date().toISOString(),
			status: failure ? 'error' : 'ok',
			text: finalText + (truncated ? TRUNCATION_NOTE : ''),
			tools: [...toolsUsed],
			tokens: Math.round(totalTokens),
			...(failure ? { error: failure } : {})
		};
		await updateRun(username, schedule.id, runId, finished).catch(() => {});
		await addUsage(username, finished.tokens, undefined, { viaApi: true }).catch(() => {});
		logAudit({
			actor: username,
			via: 'session',
			category: 'chat',
			action: 'schedule.run',
			target: schedule.title,
			status: failure ? 'error' : 'ok',
			detail: {
				scheduleId: schedule.id,
				tokens: finished.tokens,
				durationMs: Date.now() - startedMs,
				...(failure ? { error: failure } : {})
			}
		});
	})();

	return { run, done };
}

/** The sweep path: fire and await, bounding concurrency per sweep. */
export async function executeSchedule(username: string, schedule: Schedule): Promise<void> {
	const { done } = await startScheduleRun(username, schedule);
	await done;
}

import { buildAgent } from './agent';
import { connectMcpTools } from './mcp';
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
/** Hard wall-clock cap per run. */
const RUN_TIMEOUT_MS = 5 * 60_000;

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

/** One headless run — also used by the "Executar agora" button. */
export async function executeSchedule(username: string, schedule: Schedule): Promise<ScheduleRun> {
	const startedAt = new Date().toISOString();
	const started = Date.now();

	let totalTokens = 0;
	const toolsUsed = new Set<string>();
	let run: ScheduleRun;

	try {
		// Budget: a scheduled run spends the OWNER's daily tokens.
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

		try {
			const agent = await buildAgent(
				user,
				settings,
				mcp.tools,
				// Stable pseudo-conversation id: sandbox workspace files persist
				// across this schedule's runs.
				`sched-${schedule.id}`,
				await getEffectiveOrgPrompt(),
				tokenBudget,
				await resolveModel(username, '', undefined),
				'api'
			);

			const prompt =
				`[Scheduled run] These are the user's standing instructions, executed automatically on a schedule — ` +
				`they are not present to answer questions, so state assumptions instead of asking. If the ` +
				`instructions name e-mail recipients, that IS their explicit request to send. Finish with a ` +
				`concise report of what you did and found.\n\n${schedule.instructions}`;

			const result = await Promise.race([
				agent.generate({
					messages: [{ role: 'user' as const, content: prompt }],
					onStepFinish: (step: {
						usage?: Parameters<typeof weightedTokens>[0];
						toolCalls?: { toolName?: string }[];
					}) => {
						totalTokens += weightedTokens(step.usage);
						for (const call of step.toolCalls ?? []) {
							if (call.toolName) toolsUsed.add(call.toolName);
						}
					}
				}),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('run timed out')), RUN_TIMEOUT_MS)
				)
			]);

			run = {
				id: crypto.randomUUID(),
				startedAt,
				finishedAt: new Date().toISOString(),
				status: 'ok',
				text: result.text,
				tools: [...toolsUsed],
				tokens: Math.round(totalTokens)
			};
		} finally {
			await mcp.close().catch(() => {});
		}
	} catch (error) {
		run = {
			id: crypto.randomUUID(),
			startedAt,
			finishedAt: new Date().toISOString(),
			status: 'error',
			text: '',
			tools: [...toolsUsed],
			tokens: Math.round(totalTokens),
			error: error instanceof Error ? error.message.slice(0, 500) : 'run failed'
		};
	}

	await appendRun(username, schedule.id, run);
	await addUsage(username, totalTokens, undefined, { viaApi: true }).catch(() => {});
	logAudit({
		actor: username,
		via: 'session',
		category: 'chat',
		action: 'schedule.run',
		target: schedule.title,
		status: run.status === 'ok' ? 'ok' : 'error',
		detail: {
			scheduleId: schedule.id,
			tokens: run.tokens,
			durationMs: Date.now() - started,
			...(run.error ? { error: run.error } : {})
		}
	});
	return run;
}

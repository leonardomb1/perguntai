import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';

/**
 * Per-user token accounting: one JSON file per user with a day → tokens map,
 * fed by the chat stream's per-step usage and read by the daily-limit check
 * and the admin panel. Telemetry-grade (a request that starts under the limit
 * may finish over it), which is the right trade for cost control.
 */

const RETENTION_DAYS = 62;

/**
 * Cost-weighted token count for one step's usage: uncached input at 1×, cache
 * writes at 1.25×, cache reads at 0.1× (their actual billing ratios), plus
 * output. Used both for accounting and for the mid-loop budget stop.
 */
export function weightedTokens(usage?: {
	inputTokens?: number;
	outputTokens?: number;
	inputTokenDetails?: {
		noCacheTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
	};
}): number {
	if (!usage) return 0;
	const details = usage.inputTokenDetails;
	const input =
		details && (details.noCacheTokens !== undefined || details.cacheReadTokens !== undefined)
			? (details.noCacheTokens ?? 0) +
				1.25 * (details.cacheWriteTokens ?? 0) +
				0.1 * (details.cacheReadTokens ?? 0)
			: (usage.inputTokens ?? 0);
	return input + (usage.outputTokens ?? 0);
}

/** Raw (un-weighted) token split, for transparency in the stats panel. `input`
 *  is the TOTAL input (noCache + cacheRead + cacheWrite). */
export interface TokenBreakdown {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
}
interface DayUsage extends TokenBreakdown {
	weighted: number;
	/**
	 * Weighted tokens attributed to each department / policy that MATCHED the
	 * user at request time. Recorded where the usage happens (no membership
	 * store exists to reconstruct it later); a user matching several
	 * departments counts in each, so per-tag sums can exceed the total.
	 */
	byDept?: Record<string, number>;
	byPolicy?: Record<string, number>;
	/** Weighted tokens that arrived via API key (vs interactive chat). */
	api?: number;
}
interface UsageFile {
	// Legacy days are a bare number (weighted only); new days carry the breakdown.
	days: Record<string, DayUsage | number>;
}

function normDay(v: DayUsage | number | undefined): DayUsage {
	if (typeof v === 'number') return { weighted: v, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	return {
		weighted: v?.weighted ?? 0,
		input: v?.input ?? 0,
		cacheRead: v?.cacheRead ?? 0,
		cacheWrite: v?.cacheWrite ?? 0,
		output: v?.output ?? 0,
		...(v?.byDept ? { byDept: v.byDept } : {}),
		...(v?.byPolicy ? { byPolicy: v.byPolicy } : {}),
		...(v?.api ? { api: v.api } : {})
	};
}

function usagePath(username: string): string {
	const safe = username.replace(/[^a-zA-Z0-9._-]/g, '_');
	return join(env.DATA_DIR ?? 'data', 'usage', `${safe}.json`);
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

async function read(username: string): Promise<UsageFile> {
	try {
		const parsed = JSON.parse(await readFile(usagePath(username), 'utf8'));
		return { days: typeof parsed.days === 'object' && parsed.days ? parsed.days : {} };
	} catch {
		return { days: {} };
	}
}

// Serialize writes per user — parallel chats would otherwise lose updates in
// the read-modify-write cycle.
const queues = new Map<string, Promise<void>>();

export function addUsage(
	username: string,
	tokens: number,
	breakdown?: Partial<TokenBreakdown>,
	tags?: { depts?: string[]; policies?: string[]; viaApi?: boolean }
): Promise<void> {
	if (!Number.isFinite(tokens) || tokens <= 0) return Promise.resolve();
	const next = (queues.get(username) ?? Promise.resolve()).then(async () => {
		const data = await read(username);
		const key = today();
		const day = normDay(data.days[key]);
		const w = Math.round(tokens);
		day.weighted += w;
		if (breakdown) {
			day.input += Math.round(breakdown.input ?? 0);
			day.cacheRead += Math.round(breakdown.cacheRead ?? 0);
			day.cacheWrite += Math.round(breakdown.cacheWrite ?? 0);
			day.output += Math.round(breakdown.output ?? 0);
		}
		for (const id of tags?.depts ?? []) {
			day.byDept = day.byDept ?? {};
			day.byDept[id] = (day.byDept[id] ?? 0) + w;
		}
		for (const id of tags?.policies ?? []) {
			day.byPolicy = day.byPolicy ?? {};
			day.byPolicy[id] = (day.byPolicy[id] ?? 0) + w;
		}
		if (tags?.viaApi) day.api = (day.api ?? 0) + w;
		data.days[key] = day;

		const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
		for (const k of Object.keys(data.days)) if (k < cutoff) delete data.days[k];

		const path = usagePath(username);
		await mkdir(join(path, '..'), { recursive: true });
		await writeFile(path, JSON.stringify(data));
	});
	queues.set(
		username,
		next.catch(() => {})
	);
	return next;
}

/** Weighted tokens used today — the figure the daily limit is enforced on. */
export async function usageToday(username: string): Promise<number> {
	return normDay((await read(username)).days[today()]).weighted;
}

export interface UsageSummary {
	today: number; // weighted
	month: number; // weighted
	todayRaw: TokenBreakdown;
	monthRaw: TokenBreakdown;
	/** This month's weighted tokens per matched department / policy id. */
	monthByDept: Record<string, number>;
	monthByPolicy: Record<string, number>;
	todayByDept: Record<string, number>;
	/** Day → weighted tokens over the retention window (for time series). */
	days: Record<string, number>;
	/** Weighted tokens that arrived via API key. */
	monthApi: number;
	todayApi: number;
}

const emptyBreakdown = (): TokenBreakdown => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

export async function usageSummary(username: string): Promise<UsageSummary> {
	const { days } = await read(username);
	const t = today();
	const month = t.slice(0, 7);
	let todayW = 0;
	let monthW = 0;
	const todayRaw = emptyBreakdown();
	const monthRaw = emptyBreakdown();
	const monthByDept: Record<string, number> = {};
	const monthByPolicy: Record<string, number> = {};
	const todayByDept: Record<string, number> = {};
	const addInto = (acc: Record<string, number>, m?: Record<string, number>) => {
		for (const [id, w] of Object.entries(m ?? {})) acc[id] = (acc[id] ?? 0) + w;
	};
	const dayWeights: Record<string, number> = {};
	let monthApi = 0;
	let todayApi = 0;
	for (const [day, raw] of Object.entries(days)) {
		const d = normDay(raw);
		dayWeights[day] = d.weighted;
		if (day.startsWith(month)) monthApi += d.api ?? 0;
		if (day === t) todayApi += d.api ?? 0;
		if (day.startsWith(month)) {
			monthW += d.weighted;
			monthRaw.input += d.input;
			monthRaw.cacheRead += d.cacheRead;
			monthRaw.cacheWrite += d.cacheWrite;
			monthRaw.output += d.output;
			addInto(monthByDept, d.byDept);
			addInto(monthByPolicy, d.byPolicy);
		}
		if (day === t) {
			todayW += d.weighted;
			todayRaw.input += d.input;
			todayRaw.cacheRead += d.cacheRead;
			todayRaw.cacheWrite += d.cacheWrite;
			todayRaw.output += d.output;
			addInto(todayByDept, d.byDept);
		}
	}
	return {
		today: todayW,
		month: monthW,
		todayRaw,
		monthRaw,
		monthByDept,
		monthByPolicy,
		todayByDept,
		days: dayWeights,
		monthApi,
		todayApi
	};
}

/**
 * Every username with a usage file — the ground truth for "who has actually
 * used the app". Policy-admitted users have no access.json record, so the
 * stats panel enumerates THIS, not the user list.
 */
export async function listUsageUsers(): Promise<string[]> {
	try {
		const { readdir } = await import('node:fs/promises');
		const files = await readdir(join(env.DATA_DIR ?? 'data', 'usage'));
		return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
	} catch {
		return [];
	}
}

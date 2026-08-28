import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';

/**
 * Scheduled runs ("Programado"): standing instructions the agent executes on a
 * cadence with nobody logged in — the warehouse credential comes from the
 * stores that already serve API keys (credentialStore / oidcStore), so a
 * headless run queries as its owner. One JSON file per user under
 * DATA_DIR/schedules; run history (final answer + metadata, not full
 * transcripts) lives beside it, capped per schedule.
 */

export type Frequency = 'daily' | 'weekly' | 'monthly';

export interface Schedule {
	id: string;
	title: string;
	/** The standing prompt executed each run — distilled from a conversation. */
	instructions: string;
	frequency: Frequency;
	/** Local server time, 'HH:MM'. */
	time: string;
	/** weekly: 0 (Sunday) … 6 (Saturday). */
	weekday?: number;
	/** monthly: 1 … 28 (clamped — every month has these). */
	dayOfMonth?: number;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
	lastRunAt?: string;
}

export interface ScheduleRun {
	id: string;
	startedAt: string;
	finishedAt: string;
	status: 'ok' | 'error';
	/** The agent's final answer (markdown) — what the history view renders. */
	text: string;
	/** Tool names used, for the quiet "ferramentas" line. */
	tools: string[];
	tokens: number;
	error?: string;
}

const MAX_SCHEDULES = 10;
const MAX_RUNS_KEPT = 20;
const MAX_INSTRUCTIONS = 6000;
export const SCHEDULE_LIMITS = { maxSchedules: MAX_SCHEDULES, maxInstructions: MAX_INSTRUCTIONS };

function safe(username: string): string {
	return username.replace(/[^a-zA-Z0-9._-]/g, '_');
}
function schedulesPath(username: string): string {
	return join(env.DATA_DIR ?? 'data', 'schedules', `${safe(username)}.json`);
}
function runsPath(username: string, scheduleId: string): string {
	return join(env.DATA_DIR ?? 'data', 'schedules', `${safe(username)}-runs`, `${scheduleId}.json`);
}

function normalize(s: Record<string, unknown>): Schedule {
	const freq: Frequency =
		s.frequency === 'weekly' ? 'weekly' : s.frequency === 'monthly' ? 'monthly' : 'daily';
	return {
		id: typeof s.id === 'string' && s.id ? s.id : crypto.randomUUID(),
		title: typeof s.title === 'string' ? s.title.slice(0, 120) : '',
		instructions: typeof s.instructions === 'string' ? s.instructions.slice(0, MAX_INSTRUCTIONS) : '',
		frequency: freq,
		time: typeof s.time === 'string' && /^\d{2}:\d{2}$/.test(s.time) ? s.time : '08:00',
		...(freq === 'weekly'
			? { weekday: Math.min(6, Math.max(0, Number(s.weekday) || 1)) }
			: {}),
		...(freq === 'monthly'
			? { dayOfMonth: Math.min(28, Math.max(1, Number(s.dayOfMonth) || 1)) }
			: {}),
		enabled: s.enabled !== false,
		createdAt: typeof s.createdAt === 'string' ? s.createdAt : new Date().toISOString(),
		updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : new Date().toISOString(),
		...(typeof s.lastRunAt === 'string' ? { lastRunAt: s.lastRunAt } : {})
	};
}

async function readSchedules(username: string): Promise<Schedule[]> {
	try {
		const parsed = JSON.parse(await readFile(schedulesPath(username), 'utf8'));
		const list: unknown[] = Array.isArray(parsed?.schedules) ? parsed.schedules : [];
		return list
			.filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
			.map(normalize)
			.filter((s) => s.title && s.instructions);
	} catch {
		return [];
	}
}

async function writeSchedules(username: string, schedules: Schedule[]): Promise<void> {
	const path = schedulesPath(username);
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, JSON.stringify({ schedules }));
}

export async function listSchedules(username: string): Promise<Schedule[]> {
	return readSchedules(username);
}

/** Every user that has a schedules file — what the runner sweeps. */
export async function scheduleOwners(): Promise<string[]> {
	try {
		const entries = await readdir(join(env.DATA_DIR ?? 'data', 'schedules'));
		return entries.filter((e) => e.endsWith('.json')).map((e) => e.slice(0, -5));
	} catch {
		return [];
	}
}

export interface ScheduleInput {
	id?: string;
	title?: string;
	instructions?: string;
	frequency?: Frequency;
	time?: string;
	weekday?: number;
	dayOfMonth?: number;
	enabled?: boolean;
}

export type ScheduleSaveResult =
	| { ok: true; schedule: Schedule }
	| { ok: false; reason: 'full' | 'empty' | 'not_found' };

export async function saveSchedule(
	username: string,
	input: ScheduleInput
): Promise<ScheduleSaveResult> {
	const schedules = await readSchedules(username);

	if (input.id) {
		const existing = schedules.find((s) => s.id === input.id);
		if (!existing) return { ok: false, reason: 'not_found' };
		const merged = normalize({ ...existing, ...input, updatedAt: new Date().toISOString() });
		if (!merged.title || !merged.instructions) return { ok: false, reason: 'empty' };
		schedules[schedules.indexOf(existing)] = merged;
		await writeSchedules(username, schedules);
		return { ok: true, schedule: merged };
	}

	// New schedules start with lastRunAt = now so they fire at the NEXT
	// occurrence, not retroactively for today's already-passed slot.
	const fresh = normalize({ ...input, id: crypto.randomUUID(), lastRunAt: new Date().toISOString() });
	if (!fresh.title || !fresh.instructions) return { ok: false, reason: 'empty' };
	if (schedules.length >= MAX_SCHEDULES) return { ok: false, reason: 'full' };
	schedules.push(fresh);
	await writeSchedules(username, schedules);
	return { ok: true, schedule: fresh };
}

export async function removeSchedule(username: string, id: string): Promise<boolean> {
	const schedules = await readSchedules(username);
	const next = schedules.filter((s) => s.id !== id);
	if (next.length === schedules.length) return false;
	await writeSchedules(username, next);
	await rm(runsPath(username, id), { force: true }).catch(() => {});
	return true;
}

export async function markRan(username: string, id: string, at: string): Promise<void> {
	const schedules = await readSchedules(username);
	const schedule = schedules.find((s) => s.id === id);
	if (!schedule) return;
	schedule.lastRunAt = at;
	await writeSchedules(username, schedules);
}

// --- run history ---

export async function listRuns(username: string, scheduleId: string): Promise<ScheduleRun[]> {
	try {
		const parsed = JSON.parse(await readFile(runsPath(username, scheduleId), 'utf8'));
		return Array.isArray(parsed?.runs) ? (parsed.runs as ScheduleRun[]) : [];
	} catch {
		return [];
	}
}

export async function appendRun(
	username: string,
	scheduleId: string,
	run: ScheduleRun
): Promise<void> {
	const path = runsPath(username, scheduleId);
	const runs = await listRuns(username, scheduleId);
	runs.unshift(run);
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, JSON.stringify({ runs: runs.slice(0, MAX_RUNS_KEPT) }));
}

/**
 * The most recent occurrence of the schedule's cadence at or before `now`
 * (server-local time). A schedule is DUE when that occurrence is later than
 * its lastRunAt — so a missed slot (server down at 08:00) still fires on the
 * next sweep, and firing records lastRunAt to make the slot idempotent.
 */
export function latestOccurrence(schedule: Schedule, now: Date): Date | null {
	const [hh, mm] = schedule.time.split(':').map(Number);
	const at = (d: Date) =>
		new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0);

	if (schedule.frequency === 'daily') {
		const today = at(now);
		if (today <= now) return today;
		const y = new Date(now);
		y.setDate(y.getDate() - 1);
		return at(y);
	}
	if (schedule.frequency === 'weekly') {
		const target = schedule.weekday ?? 1;
		const d = new Date(now);
		for (let back = 0; back < 8; back++) {
			if (d.getDay() === target) {
				const occ = at(d);
				if (occ <= now) return occ;
			}
			d.setDate(d.getDate() - 1);
		}
		return null;
	}
	// monthly
	const day = schedule.dayOfMonth ?? 1;
	const thisMonth = new Date(now.getFullYear(), now.getMonth(), day, hh, mm, 0, 0);
	if (thisMonth <= now) return thisMonth;
	return new Date(now.getFullYear(), now.getMonth() - 1, day, hh, mm, 0, 0);
}

export function isDue(schedule: Schedule, now: Date): boolean {
	if (!schedule.enabled) return false;
	const occurrence = latestOccurrence(schedule, now);
	if (!occurrence) return false;
	return !schedule.lastRunAt || new Date(schedule.lastRunAt) < occurrence;
}

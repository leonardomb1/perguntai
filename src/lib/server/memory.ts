import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';

/**
 * Per-user memory: durable, self-scoped knowledge the assistant keeps about a
 * user, organized by TOPIC (like Claude's own memory). Each topic has a title, a
 * one-line summary, and a markdown details body that can grow large. One JSON
 * file per user under DATA_DIR/memory — separate from settings so it never
 * bloats the settings file.
 *
 * Opt-in (settings.memoryEnabled), agent-written via explicit tools
 * (saveMemory/forgetMemory) and fully user-visible: the owner reads, edits and
 * deletes every topic from Settings (LGPD right to erasure). Never shared across
 * users — the private counterpart to the org/department knowledge base.
 */

export interface UserMemory {
	id: string;
	title: string;
	/** One-line description of the topic. */
	summary: string;
	/** Markdown body — can be long. */
	details: string;
	/** Who wrote it: the agent (via a tool) or the user (in Settings). */
	source: 'agent' | 'user';
	createdAt: string;
	updatedAt: string;
	/** Provenance: the conversation the agent learned it in (agent source). */
	conversationId?: string;
}

const MAX_MEMORIES = 40;
const MAX_TITLE = 120;
const MAX_SUMMARY = 300;
const MAX_DETAILS = 6000;
export const MEMORY_LIMITS = { maxMemories: MAX_MEMORIES, maxDetails: MAX_DETAILS };

function memoryPath(username: string): string {
	const safe = username.replace(/[^a-zA-Z0-9._-]/g, '_');
	return join(env.DATA_DIR ?? 'data', 'memory', `${safe}.json`);
}

function nowIso(): string {
	return new Date().toISOString();
}

/** Coerce one stored record to the current shape (migrates the old flat `text`). */
function normalize(m: Record<string, unknown>): UserMemory {
	const legacyText = typeof m.text === 'string' ? m.text : '';
	return {
		id: typeof m.id === 'string' && m.id ? m.id : crypto.randomUUID(),
		title: typeof m.title === 'string' ? m.title.slice(0, MAX_TITLE) : '',
		summary:
			typeof m.summary === 'string' ? m.summary.slice(0, MAX_SUMMARY) : legacyText.slice(0, MAX_SUMMARY),
		details: typeof m.details === 'string' ? m.details.slice(0, MAX_DETAILS) : '',
		source: m.source === 'user' ? 'user' : 'agent',
		createdAt: typeof m.createdAt === 'string' ? m.createdAt : nowIso(),
		updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : (typeof m.createdAt === 'string' ? m.createdAt : nowIso()),
		...(typeof m.conversationId === 'string' ? { conversationId: m.conversationId } : {})
	};
}

async function readAll(username: string): Promise<UserMemory[]> {
	try {
		const parsed = JSON.parse(await readFile(memoryPath(username), 'utf8'));
		const list: unknown[] = Array.isArray(parsed?.memories) ? parsed.memories : [];
		return list
			.filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
			.map(normalize)
			.filter((m) => m.title.trim() || m.summary.trim() || m.details.trim());
	} catch {
		return [];
	}
}

async function writeAll(username: string, memories: UserMemory[]): Promise<void> {
	const path = memoryPath(username);
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, JSON.stringify({ memories }));
}

export async function listMemories(username: string): Promise<UserMemory[]> {
	return readAll(username);
}

export interface MemoryInput {
	id?: string;
	title?: string;
	summary?: string;
	details?: string;
}

export type SaveResult =
	| { ok: true; memory: UserMemory }
	| { ok: false; reason: 'full' | 'empty' | 'not_found' };

/**
 * Create a topic (no id) or update an existing one (id given). Empty input is
 * rejected; a new topic past the cap returns 'full'; an unknown id returns
 * 'not_found'.
 */
export async function saveMemory(
	username: string,
	input: MemoryInput,
	source: 'agent' | 'user',
	conversationId?: string
): Promise<SaveResult> {
	const title = (input.title ?? '').trim().slice(0, MAX_TITLE);
	const summary = (input.summary ?? '').trim().slice(0, MAX_SUMMARY);
	const details = (input.details ?? '').trim().slice(0, MAX_DETAILS);
	if (!title && !summary && !details) return { ok: false, reason: 'empty' };

	const memories = await readAll(username);

	if (input.id) {
		const existing = memories.find((m) => m.id === input.id);
		if (!existing) return { ok: false, reason: 'not_found' };
		existing.title = title;
		existing.summary = summary;
		existing.details = details;
		existing.updatedAt = nowIso();
		await writeAll(username, memories);
		return { ok: true, memory: existing };
	}

	if (memories.length >= MAX_MEMORIES) return { ok: false, reason: 'full' };
	const memory: UserMemory = {
		id: crypto.randomUUID(),
		title,
		summary,
		details,
		source,
		createdAt: nowIso(),
		updatedAt: nowIso(),
		...(conversationId ? { conversationId } : {})
	};
	memories.push(memory);
	await writeAll(username, memories);
	return { ok: true, memory };
}

export async function removeMemory(username: string, id: string): Promise<boolean> {
	const memories = await readAll(username);
	const next = memories.filter((m) => m.id !== id);
	if (next.length === memories.length) return false;
	await writeAll(username, next);
	return true;
}

export async function clearMemories(username: string): Promise<void> {
	await writeAll(username, []);
}

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';
import type { UIMessage } from 'ai';
import { removeDocsForConversation } from './rag';

/**
 * Server-side conversation store: one index per user plus one JSON file per
 * conversation, under DATA_DIR (same pattern as the document store). Being
 * server-side gives cross-device history, no localStorage quota issues, and
 * lets conversation deletion cascade to the documents attached to it.
 */

const MAX_CONVERSATIONS = 500;

export interface ConversationMeta {
	id: string;
	title: string;
	updatedAt: number;
}

/** Client-generated ids — validate hard before they touch the filesystem. */
export function isValidConversationId(id: unknown): id is string {
	return typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id);
}

function userDir(username: string): string {
	const safe = username.replace(/[^a-zA-Z0-9._-]/g, '_');
	return join(env.DATA_DIR ?? 'data', 'conversations', safe);
}

async function readIndex(username: string): Promise<ConversationMeta[]> {
	try {
		return JSON.parse(await readFile(join(userDir(username), 'index.json'), 'utf8'));
	} catch {
		return [];
	}
}

async function writeIndex(username: string, index: ConversationMeta[]): Promise<void> {
	const dir = userDir(username);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'index.json'), JSON.stringify(index));
}

/** Newest first. */
export async function listConversations(username: string): Promise<ConversationMeta[]> {
	return (await readIndex(username)).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadMessages(username: string, id: string): Promise<UIMessage[]> {
	try {
		return JSON.parse(await readFile(join(userDir(username), `${id}.json`), 'utf8'));
	} catch {
		return [];
	}
}

export async function saveConversation(
	username: string,
	id: string,
	messages: UIMessage[],
	title?: string
): Promise<void> {
	if (messages.length === 0) return;
	const dir = userDir(username);
	const path = join(dir, `${id}.json`);
	const body = JSON.stringify(messages);

	// Identical content → no-op, so merely viewing a chat never bumps its
	// position in the list.
	const existing = await readFile(path, 'utf8').catch(() => null);
	if (existing === body) return;

	await mkdir(dir, { recursive: true });
	await writeFile(path, body);

	const index = await readIndex(username);
	const current = index.find((c) => c.id === id);
	// Titles are sticky once set (they may have been renamed); derive one from
	// the first user message only for brand-new conversations.
	const resolvedTitle =
		current?.title ??
		title ??
		messages
			.find((m) => m.role === 'user')
			?.parts.find((p) => p.type === 'text')
			?.text.slice(0, 60) ??
		'New chat';

	const next = index.filter((c) => c.id !== id);
	next.unshift({ id, title: resolvedTitle, updatedAt: Date.now() });

	// Evict the oldest beyond the cap, including their files and documents.
	for (const evicted of next.slice(MAX_CONVERSATIONS)) {
		await rm(join(dir, `${evicted.id}.json`), { force: true }).catch(() => {});
		await removeDocsForConversation(username, evicted.id).catch(() => {});
	}
	await writeIndex(username, next.slice(0, MAX_CONVERSATIONS));
}

export async function renameConversation(
	username: string,
	id: string,
	title: string
): Promise<void> {
	const clean = title.trim().slice(0, 80);
	if (!clean) return;
	const index = await readIndex(username);
	const entry = index.find((c) => c.id === id);
	if (!entry) return;
	entry.title = clean;
	await writeIndex(username, index);
}

/** Deletes the conversation AND the documents attached to it. */
export async function deleteConversation(username: string, id: string): Promise<void> {
	await rm(join(userDir(username), `${id}.json`), { force: true }).catch(() => {});
	await writeIndex(username, (await readIndex(username)).filter((c) => c.id !== id));
	await removeDocsForConversation(username, id);
}

import { browser } from '$app/environment';
import type { UIMessage } from 'ai';
import { getToken } from '$lib/session';

/**
 * Conversation history client — conversations live SERVER-SIDE (per user,
 * under DATA_DIR), so history follows the user across devices and deleting a
 * conversation cascades to its attached documents. This module is a thin
 * authenticated wrapper over /api/conversations.
 */

export interface ConversationMeta {
	id: string;
	title: string;
	updatedAt: number;
}

function headers(json = false): Record<string, string> {
	return {
		Authorization: `Bearer ${getToken() ?? ''}`,
		...(json ? { 'Content-Type': 'application/json' } : {})
	};
}

export async function listConversations(): Promise<ConversationMeta[]> {
	try {
		const res = await fetch('/api/conversations', { headers: headers() });
		if (!res.ok) return [];
		return (await res.json()).conversations;
	} catch {
		return [];
	}
}

export async function loadMessages(id: string): Promise<UIMessage[]> {
	try {
		const res = await fetch(`/api/conversations?id=${encodeURIComponent(id)}`, {
			headers: headers()
		});
		if (!res.ok) return [];
		return (await res.json()).messages;
	} catch {
		return [];
	}
}

export async function saveConversation(id: string, messages: UIMessage[]): Promise<void> {
	if (messages.length === 0) return;
	try {
		await fetch('/api/conversations', {
			method: 'PUT',
			headers: headers(true),
			body: JSON.stringify({ id, messages })
		});
	} catch {
		/* autosave — a failed save retries on the next debounce tick */
	}
}

export async function renameConversation(id: string, title: string): Promise<void> {
	await fetch('/api/conversations', {
		method: 'PATCH',
		headers: headers(true),
		body: JSON.stringify({ id, title })
	}).catch(() => {});
}

export async function deleteConversation(id: string): Promise<void> {
	await fetch(`/api/conversations?id=${encodeURIComponent(id)}`, {
		method: 'DELETE',
		headers: headers()
	}).catch(() => {});
}

// --- one-time migration of pre-server localStorage history ---

const LEGACY_INDEX = 'perguntai_conversations';
const LEGACY_PREFIX = 'perguntai_convo_';

export async function migrateLocalConversations(): Promise<boolean> {
	if (!browser) return false;
	const raw = localStorage.getItem(LEGACY_INDEX);
	if (!raw) return false;

	try {
		const index: ConversationMeta[] = JSON.parse(raw);
		for (const meta of index) {
			const body = localStorage.getItem(LEGACY_PREFIX + meta.id);
			if (!body) continue;
			const messages: UIMessage[] = JSON.parse(body);
			await fetch('/api/conversations', {
				method: 'PUT',
				headers: headers(true),
				body: JSON.stringify({ id: meta.id, messages, title: meta.title })
			});
			localStorage.removeItem(LEGACY_PREFIX + meta.id);
		}
		localStorage.removeItem(LEGACY_INDEX);
		return index.length > 0;
	} catch {
		return false;
	}
}

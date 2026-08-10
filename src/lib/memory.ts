import { getToken } from '$lib/session';

/** Client for /api/memory — the user's own personal memory (topics). */

export interface UserMemory {
	id: string;
	title: string;
	summary: string;
	details: string;
	source: 'agent' | 'user';
	createdAt: string;
	updatedAt: string;
	conversationId?: string;
}

export interface MemoryInput {
	id?: string;
	title: string;
	summary: string;
	details: string;
}

function headers(): Record<string, string> {
	return { Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': 'application/json' };
}

export async function listMemories(): Promise<UserMemory[]> {
	try {
		const res = await fetch('/api/memory', { headers: headers() });
		if (!res.ok) return [];
		return (await res.json()).memories ?? [];
	} catch {
		return [];
	}
}

/** Create (no id) or update (id given) a topic. */
export async function saveMemory(input: MemoryInput): Promise<UserMemory | null> {
	const res = await fetch('/api/memory', {
		method: 'POST',
		headers: headers(),
		body: JSON.stringify(input)
	});
	if (!res.ok) return null;
	return (await res.json()).memory ?? null;
}

export async function removeMemory(id: string): Promise<boolean> {
	const res = await fetch(`/api/memory?id=${encodeURIComponent(id)}`, {
		method: 'DELETE',
		headers: headers()
	});
	return res.ok;
}

export async function clearMemories(): Promise<boolean> {
	const res = await fetch('/api/memory?all=1', { method: 'DELETE', headers: headers() });
	return res.ok;
}

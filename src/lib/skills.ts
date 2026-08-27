import { getToken } from '$lib/session';

/** Client for /api/skills — the user's own learned skills (playbooks). */

export interface UserSkill {
	id: string;
	name: string;
	description: string;
	content: string;
	source: 'agent' | 'user' | 'admin';
	createdAt: string;
	updatedAt: string;
	uses: number;
	conversationId?: string;
}

export interface SkillInput {
	id?: string;
	name: string;
	description: string;
	content: string;
}

function headers(): Record<string, string> {
	return {
		Authorization: `Bearer ${getToken() ?? ''}`,
		'Content-Type': 'application/json'
	};
}

export async function listSkills(): Promise<UserSkill[]> {
	try {
		const res = await fetch('/api/skills', { headers: headers() });
		if (!res.ok) return [];
		return (await res.json()).skills ?? [];
	} catch {
		return [];
	}
}

/** Create (no id) or update (id given) a skill. */
export async function saveSkill(input: SkillInput): Promise<UserSkill | null> {
	const res = await fetch('/api/skills', {
		method: 'POST',
		headers: headers(),
		body: JSON.stringify(input)
	});
	if (!res.ok) return null;
	return (await res.json()).skill ?? null;
}

export async function removeSkill(id: string): Promise<boolean> {
	const res = await fetch(`/api/skills?id=${encodeURIComponent(id)}`, {
		method: 'DELETE',
		headers: headers()
	});
	return res.ok;
}

/** Departments the current user matches — valid share targets besides 'org'. */
export async function listShareScopes(): Promise<{ id: string; name: string }[]> {
	try {
		const res = await fetch('/api/skills/propose', { headers: headers() });
		if (!res.ok) return [];
		return (await res.json()).departments ?? [];
	} catch {
		return [];
	}
}

/** Propose a skill for shared use ('org' or a department id). */
export async function proposeSkillTo(
	id: string,
	scope: string
): Promise<'ok' | 'duplicate' | 'error'> {
	try {
		const res = await fetch('/api/skills/propose', {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify({ id, scope })
		});
		if (res.ok) return 'ok';
		return res.status === 409 ? 'duplicate' : 'error';
	} catch {
		return 'error';
	}
}

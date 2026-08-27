import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';

/**
 * Learned skills: PROCEDURAL memory the agent writes after succeeding at a
 * non-trivial task — the "how" counterpart of user memory's "what". Each skill
 * is a markdown playbook (exact tables/filters, pitfalls, verification steps)
 * the agent loads on demand the next time a similar task appears, so the
 * platform gets better at THIS org's warehouse the more it is used.
 *
 * Two tiers, mirroring the knowledge base's trust model:
 * - Per-user (DATA_DIR/skills/<user>.json): agent-written freely via tools,
 *   fully user-visible in Settings. Same trust level as user memory.
 * - Shared (DATA_DIR/skills/_shared/{org,dept-<id>}.json): the agent can only
 *   PROPOSE into these (enabled:false); an admin approves in the console
 *   before anyone else's assistant sees it. Model proposes, human ratifies —
 *   a silently poisoned shared skill would misdirect every user.
 */

export interface Skill {
	id: string;
	/** Short imperative name, e.g. "Calcular SLA de TI". */
	name: string;
	/** One line — this is what rides in the prompt manifest. */
	description: string;
	/** Markdown playbook: procedure, pitfalls, verification. */
	content: string;
	source: 'agent' | 'user' | 'admin';
	createdAt: string;
	updatedAt: string;
	/** Times loaded via useSkill — surfaces what is actually earning its keep. */
	uses: number;
	/** Provenance: conversation where the agent learned it. */
	conversationId?: string;
	/** Shared stores only: false while awaiting admin approval. */
	enabled?: boolean;
	/** Shared stores only: who proposed it. */
	proposedBy?: string;
}

const MAX_SKILLS = 60;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 300;
const MAX_CONTENT = 12_000;
export const SKILL_LIMITS = { maxSkills: MAX_SKILLS, maxContent: MAX_CONTENT };

export const orgSkillScope = 'org';
export const deptSkillScope = (deptId: string) => `dept-${deptId}`;

function userPath(username: string): string {
	const safe = username.replace(/[^a-zA-Z0-9._-]/g, '_');
	return join(env.DATA_DIR ?? 'data', 'skills', `${safe}.json`);
}

function sharedPath(scope: string): string {
	const safe = scope.replace(/[^a-zA-Z0-9._-]/g, '_');
	return join(env.DATA_DIR ?? 'data', 'skills', '_shared', `${safe}.json`);
}

function nowIso(): string {
	return new Date().toISOString();
}

function normalize(s: Record<string, unknown>): Skill {
	return {
		id: typeof s.id === 'string' && s.id ? s.id : crypto.randomUUID(),
		name: typeof s.name === 'string' ? s.name.slice(0, MAX_NAME) : '',
		description: typeof s.description === 'string' ? s.description.slice(0, MAX_DESCRIPTION) : '',
		content: typeof s.content === 'string' ? s.content.slice(0, MAX_CONTENT) : '',
		source: s.source === 'user' ? 'user' : s.source === 'admin' ? 'admin' : 'agent',
		createdAt: typeof s.createdAt === 'string' ? s.createdAt : nowIso(),
		updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : nowIso(),
		uses: typeof s.uses === 'number' ? s.uses : 0,
		...(typeof s.conversationId === 'string' ? { conversationId: s.conversationId } : {}),
		...(typeof s.enabled === 'boolean' ? { enabled: s.enabled } : {}),
		...(typeof s.proposedBy === 'string' ? { proposedBy: s.proposedBy } : {})
	};
}

async function readStore(path: string): Promise<Skill[]> {
	try {
		const parsed = JSON.parse(await readFile(path, 'utf8'));
		const list: unknown[] = Array.isArray(parsed?.skills) ? parsed.skills : [];
		return list
			.filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
			.map(normalize)
			.filter((s) => s.name.trim() && s.content.trim());
	} catch {
		return [];
	}
}

async function writeStore(path: string, skills: Skill[]): Promise<void> {
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, JSON.stringify({ skills }));
}

export async function listSkills(username: string): Promise<Skill[]> {
	return readStore(userPath(username));
}

export async function listSharedSkills(
	scope: string,
	{ includeDisabled = false } = {}
): Promise<Skill[]> {
	const skills = await readStore(sharedPath(scope));
	return includeDisabled ? skills : skills.filter((s) => s.enabled === true);
}

export interface SkillInput {
	id?: string;
	name?: string;
	description?: string;
	content?: string;
}

export type SkillSaveResult =
	{ ok: true; skill: Skill } | { ok: false; reason: 'full' | 'empty' | 'not_found' };

/** Create (no id) or update (id given) a per-user skill. */
export async function saveSkill(
	username: string,
	input: SkillInput,
	source: Skill['source'],
	conversationId?: string
): Promise<SkillSaveResult> {
	const name = (input.name ?? '').trim().slice(0, MAX_NAME);
	const description = (input.description ?? '').trim().slice(0, MAX_DESCRIPTION);
	const content = (input.content ?? '').trim().slice(0, MAX_CONTENT);
	if (!name || !content) return { ok: false, reason: 'empty' };

	const path = userPath(username);
	const skills = await readStore(path);

	if (input.id) {
		const existing = skills.find((s) => s.id === input.id);
		if (!existing) return { ok: false, reason: 'not_found' };
		existing.name = name;
		existing.description = description;
		existing.content = content;
		existing.updatedAt = nowIso();
		await writeStore(path, skills);
		return { ok: true, skill: existing };
	}

	if (skills.length >= MAX_SKILLS) return { ok: false, reason: 'full' };
	const skill: Skill = {
		id: crypto.randomUUID(),
		name,
		description,
		content,
		source,
		createdAt: nowIso(),
		updatedAt: nowIso(),
		uses: 0,
		...(conversationId ? { conversationId } : {})
	};
	skills.push(skill);
	await writeStore(path, skills);
	return { ok: true, skill };
}

export async function removeSkill(username: string, id: string): Promise<boolean> {
	const path = userPath(username);
	const skills = await readStore(path);
	const next = skills.filter((s) => s.id !== id);
	if (next.length === skills.length) return false;
	await writeStore(path, next);
	return true;
}

/**
 * Copy a user's skill into a shared scope as a PENDING proposal
 * (enabled:false) — activates only when an admin approves it in the console.
 */
export async function proposeSkill(
	username: string,
	skillId: string,
	scope: string
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'duplicate' }> {
	const own = (await readStore(userPath(username))).find((s) => s.id === skillId);
	if (!own) return { ok: false, reason: 'not_found' };

	const path = sharedPath(scope);
	const shared = await readStore(path);
	if (shared.some((s) => s.name.toLowerCase() === own.name.toLowerCase())) {
		return { ok: false, reason: 'duplicate' };
	}
	shared.push({
		...own,
		id: crypto.randomUUID(),
		uses: 0,
		enabled: false,
		proposedBy: username,
		createdAt: nowIso(),
		updatedAt: nowIso()
	});
	await writeStore(path, shared);
	return { ok: true };
}

/** Admin: approve (enable), suspend (disable) — a missing id returns false. */
export async function setSharedSkillEnabled(
	scope: string,
	id: string,
	enabled: boolean
): Promise<boolean> {
	const path = sharedPath(scope);
	const skills = await readStore(path);
	const skill = skills.find((s) => s.id === id);
	if (!skill) return false;
	skill.enabled = enabled;
	skill.updatedAt = nowIso();
	await writeStore(path, skills);
	return true;
}

/** Admin: reject a proposal or delete an approved shared skill. */
export async function removeSharedSkill(scope: string, id: string): Promise<boolean> {
	const path = sharedPath(scope);
	const skills = await readStore(path);
	const next = skills.filter((s) => s.id !== id);
	if (next.length === skills.length) return false;
	await writeStore(path, next);
	return true;
}

export interface SkillManifestEntry {
	id: string;
	name: string;
	description: string;
	source: string;
}

/**
 * Everything this user's assistant can load: own skills + enabled org +
 * enabled department skills. Stable order (scope, then createdAt) so the
 * prompt prefix only changes when a skill actually changes.
 */
export async function skillsManifest(
	username: string,
	depts: { id: string; name: string }[]
): Promise<SkillManifestEntry[]> {
	const own = await listSkills(username);
	const org = await listSharedSkills(orgSkillScope);
	const byDept: { dept: string; skills: Skill[] }[] = [];
	for (const d of depts)
		byDept.push({
			dept: d.name,
			skills: await listSharedSkills(deptSkillScope(d.id))
		});

	const sortByCreated = (a: Skill, b: Skill) => a.createdAt.localeCompare(b.createdAt);
	return [
		...own.sort(sortByCreated).map((s) => ({
			id: s.id,
			name: s.name,
			description: s.description,
			source: 'personal'
		})),
		...org.sort(sortByCreated).map((s) => ({
			id: s.id,
			name: s.name,
			description: s.description,
			source: 'organization'
		})),
		...byDept.flatMap(({ dept, skills }) =>
			skills.sort(sortByCreated).map((s) => ({
				id: s.id,
				name: s.name,
				description: s.description,
				source: dept
			}))
		)
	];
}

/**
 * Fetch one skill by id or fuzzy name across every scope the user can reach,
 * bumping its use counter. User skills win name ties (most specific first).
 */
export async function resolveSkill(
	username: string,
	depts: { id: string; name: string }[],
	nameOrId: string
): Promise<{ skill: Skill; scope: string } | null> {
	const needle = nameOrId.trim().toLowerCase();
	const stores: { scope: string; path: string; filterEnabled: boolean }[] = [
		{ scope: 'personal', path: userPath(username), filterEnabled: false },
		{
			scope: 'organization',
			path: sharedPath(orgSkillScope),
			filterEnabled: true
		},
		...depts.map((d) => ({
			scope: d.name,
			path: sharedPath(deptSkillScope(d.id)),
			filterEnabled: true
		}))
	];
	for (const pass of ['exact', 'fuzzy'] as const) {
		for (const store of stores) {
			const skills = (await readStore(store.path)).filter(
				(s) => !store.filterEnabled || s.enabled === true
			);
			const skill = skills.find((s) =>
				pass === 'exact'
					? s.id === nameOrId || s.name.toLowerCase() === needle
					: s.name.toLowerCase().includes(needle)
			);
			if (skill) {
				skill.uses += 1;
				await writeStore(store.path, skills).catch(() => {});
				return { skill, scope: store.scope };
			}
		}
	}
	return null;
}

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';
import { DEFAULT_MODEL, MODEL_IDS } from './models';
import type { UserProfile } from './auth';

/**
 * Runtime access control, replacing the ALLOWED_USERS env var: an admin-managed
 * user list (role, blocked flag, per-user daily token limit) plus an
 * organization-wide system prompt, stored at DATA_DIR/access.json.
 *
 * Because `authenticateRequest` consults this store ON EVERY REQUEST (tokens
 * stay stateless JWEs), blocking or removing a user locks them out on their
 * very next request — no session store or token blacklist needed.
 *
 * Semantics carried over from ALLOWED_USERS: an EMPTY user list means open
 * mode (anyone with valid LDAPS credentials may sign in). Bootstrap: on first
 * load the file is seeded from ALLOWED_USERS, and ADMIN_USERS names the
 * bootstrap admin(s) — env admins are always allowed and always admins, so an
 * admin can never lock themselves out of the panel.
 */

export type Role = 'admin' | 'builder' | 'user';

export interface AccessUser {
	role: Role;
	blocked: boolean;
	maxDailyTokens: number | null;
	/**
	 * Extra model IDs this user may pick, ON TOP of DEFAULT_MODEL (which everyone
	 * always gets). Empty/undefined = default only. Admins implicitly get every
	 * model regardless of this list. See resolveAllowedModels.
	 */
	allowedModels?: string[];
	/**
	 * Lets the MODEL compose write statements (INSERT/UPDATE/DELETE/CREATE) in
	 * queryDatabase, on top of the read-only default. Not a database permission:
	 * StarRocks still authorizes every statement against this user's own grants,
	 * so the flag only decides whether the model may write under grants they
	 * already have. Irreversible statements stay blocked either way (sql-guard).
	 * Chat only — flow runs are always read-only. Admin-set; never self-granted.
	 */
	sqlWrite?: boolean;
	/**
	 * Lets the MODEL mutate the Windmill workspace — create/update/delete flows,
	 * scripts, schedules, variables, resources, apps — on top of the read-only
	 * default. Like sqlWrite, not a permission: the user's own Windmill token
	 * already scopes what they could do by hand; this decides whether the model
	 * may do it for them. Running scripts/flows is NOT gated by this (it's in the
	 * read-only set). Chat only — flow runs are always read-only. Admin-set.
	 */
	windmillWrite?: boolean;
	addedBy: string;
	addedAt: string;
}

/**
 * One titled block of the organization knowledge base — a definition, a
 * convention, a glossary section. Human-curated (admins), NOT agent-written:
 * shared-scope memory is a trust boundary, so the model may only ever propose
 * entries, never write them silently. Enabled entries are concatenated into the
 * effective org prompt injected above every user's own instructions.
 */
export interface OrgKnowledgeEntry {
	id: string;
	title: string;
	body: string;
	enabled: boolean;
}

/**
 * Which users a department's knowledge applies to. A user matches if ANY
 * populated rule hits their session profile (OR semantics). An all-empty match
 * matches nobody — a department only takes effect once a rule is set. Evaluated
 * per request from the token; no user-profile store exists, so membership is
 * never persisted or enumerable server-side.
 */
export interface DeptMatch {
	/** memberOf contains any of these AD groups (case-insensitive). */
	adGroups?: string[];
	/** costCenterCode equals any of these. */
	costCenters?: string[];
	/** costCenterCode starts with this (for cost-center hierarchies). */
	costCenterPrefix?: string;
}

/** A department: a name, a membership rule, and its own knowledge blocks. */
export interface Department {
	id: string;
	name: string;
	enabled: boolean;
	match: DeptMatch;
	knowledge: OrgKnowledgeEntry[];
}

interface AccessFile {
	users: Record<string, AccessUser>;
	/** Free-text standing instructions applied to every user (behavioral). */
	orgSystemPrompt: string;
	/** Structured, toggleable knowledge blocks (definitions/conventions). */
	orgKnowledge: OrgKnowledgeEntry[];
	/** Department-scoped knowledge, injected only for matching users. */
	departments: Department[];
}

const MAX_ORG_PROMPT = 4000;
const MAX_ENTRY_BODY = 4000;
const MAX_ENTRY_TITLE = 120;
const MAX_ENTRIES = 40;
const MAX_DEPARTMENTS = 30;
const MAX_MATCH_LIST = 50;

function sanitizeKnowledge(raw: unknown): OrgKnowledgeEntry[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
		.slice(0, MAX_ENTRIES)
		.map((e) => ({
			id: typeof e.id === 'string' && e.id ? e.id : crypto.randomUUID(),
			title: typeof e.title === 'string' ? e.title.slice(0, MAX_ENTRY_TITLE) : '',
			body: typeof e.body === 'string' ? e.body.slice(0, MAX_ENTRY_BODY) : '',
			enabled: e.enabled !== false
		}))
		.filter((e) => e.title.trim() || e.body.trim());
}

function sanitizeStrList(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const list = raw
		.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
		.map((x) => x.trim())
		.slice(0, MAX_MATCH_LIST);
	return list.length ? list : undefined;
}

function sanitizeMatch(raw: unknown): DeptMatch {
	const m = typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : {};
	const match: DeptMatch = {};
	const groups = sanitizeStrList(m.adGroups);
	if (groups) match.adGroups = groups;
	const ccs = sanitizeStrList(m.costCenters);
	if (ccs) match.costCenters = ccs;
	if (typeof m.costCenterPrefix === 'string' && m.costCenterPrefix.trim())
		match.costCenterPrefix = m.costCenterPrefix.trim().slice(0, 32);
	return match;
}

function sanitizeDepartments(raw: unknown): Department[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
		.slice(0, MAX_DEPARTMENTS)
		.map((d) => ({
			id: typeof d.id === 'string' && d.id ? d.id : crypto.randomUUID(),
			name: typeof d.name === 'string' ? d.name.slice(0, MAX_ENTRY_TITLE) : '',
			enabled: d.enabled !== false,
			match: sanitizeMatch(d.match),
			knowledge: sanitizeKnowledge(d.knowledge)
		}))
		.filter((d) => d.name.trim());
}

/** True when the profile satisfies any populated rule (empty match → false). */
function matchesDept(match: DeptMatch, profile: UserProfile): boolean {
	if (match.adGroups?.length) {
		const groups = new Set(profile.memberOf.map((g) => g.toLowerCase()));
		if (match.adGroups.some((g) => groups.has(g.toLowerCase()))) return true;
	}
	const cc = profile.costCenterCode;
	if (cc) {
		if (match.costCenters?.includes(cc)) return true;
		if (match.costCenterPrefix && cc.startsWith(match.costCenterPrefix)) return true;
	}
	return false;
}

/** Renders one knowledge block, headed by its title (and department name). */
function blockText(entry: OrgKnowledgeEntry, deptName?: string): string {
	const head = [deptName, entry.title.trim()].filter(Boolean).join(' — ');
	const body = entry.body.trim();
	return head ? `## ${head}\n${body}` : body;
}

function accessPath(): string {
	return join(env.DATA_DIR ?? 'data', 'access.json');
}

function envAdmins(): string[] {
	return (env.ADMIN_USERS ?? '')
		.split(',')
		.map((u) => u.trim().toLowerCase())
		.filter(Boolean);
}

export function isEnvAdmin(username: string): boolean {
	return envAdmins().includes(username.toLowerCase());
}

let cache: { mtime: number; data: AccessFile } | null = null;

async function load(): Promise<AccessFile> {
	const path = accessPath();
	try {
		const s = await stat(path);
		if (cache && cache.mtime === s.mtimeMs) return cache.data;
		const parsed = JSON.parse(await readFile(path, 'utf8'));
		const data: AccessFile = {
			users: typeof parsed.users === 'object' && parsed.users ? parsed.users : {},
			orgSystemPrompt: typeof parsed.orgSystemPrompt === 'string' ? parsed.orgSystemPrompt : '',
			orgKnowledge: sanitizeKnowledge(parsed.orgKnowledge),
			departments: sanitizeDepartments(parsed.departments)
		};
		cache = { mtime: s.mtimeMs, data };
		return data;
	} catch {
		// First run — seed from the legacy env allowlist, then persist.
		const seeded: AccessFile = { users: {}, orgSystemPrompt: '', orgKnowledge: [], departments: [] };
		const legacy = (env.ALLOWED_USERS ?? '')
			.split(',')
			.map((u) => u.trim().toLowerCase())
			.filter(Boolean);
		for (const username of legacy) {
			seeded.users[username] = {
				role: isEnvAdmin(username) ? 'admin' : 'user',
				blocked: false,
				maxDailyTokens: null,
				addedBy: 'env:ALLOWED_USERS',
				addedAt: new Date().toISOString()
			};
		}
		await save(seeded);
		return seeded;
	}
}

async function save(data: AccessFile): Promise<void> {
	const path = accessPath();
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, JSON.stringify(data, null, '\t'));
	cache = null; // next read picks up the new mtime
}

/** Key lookup used by authenticateRequest — empty list = open mode. */
export async function isUserAllowed(username: string): Promise<boolean> {
	if (isEnvAdmin(username)) return true;
	const { users } = await load();
	const names = Object.keys(users);
	if (names.length === 0) return true;
	const entry = users[username.toLowerCase()];
	return Boolean(entry && !entry.blocked);
}

export async function resolveRole(username: string): Promise<Role> {
	if (isEnvAdmin(username)) return 'admin';
	const { users } = await load();
	const role = users[username.toLowerCase()]?.role;
	return role === 'admin' || role === 'builder' ? role : 'user';
}

/**
 * Whether the model may compose write statements under this user's own grants.
 * Deliberately NOT implied by the admin role (unlike resolveAllowedModels):
 * letting an LLM write is a per-person decision, not a rank. Re-read per
 * request, so revoking it takes effect on the user's next message.
 */
export async function resolveSqlWrite(username: string): Promise<boolean> {
	return (await getAccessEntry(username))?.sqlWrite === true;
}

/**
 * Whether the model may mutate the Windmill workspace under this user's own
 * token. Same reasoning as resolveSqlWrite: not implied by the admin role, and
 * re-read per request so revoking it lands on the next message.
 */
export async function resolveWindmillWrite(username: string): Promise<boolean> {
	return (await getAccessEntry(username))?.windmillWrite === true;
}

export async function getAccessEntry(username: string): Promise<AccessUser | null> {
	const { users } = await load();
	return users[username.toLowerCase()] ?? null;
}

export async function listAccessUsers(): Promise<Record<string, AccessUser>> {
	return (await load()).users;
}

export async function upsertAccessUser(
	username: string,
	patch: Partial<
		Pick<AccessUser, 'role' | 'blocked' | 'maxDailyTokens' | 'allowedModels' | 'sqlWrite' | 'windmillWrite'>
	>,
	actor: string
): Promise<void> {
	const key = username.trim().toLowerCase();
	if (!/^[a-z0-9._-]{2,64}$/.test(key)) throw new Error('invalid username');
	// Env admins are the bootstrap safety net — they cannot be blocked or
	// demoted out of the admin role.
	if (isEnvAdmin(key) && (patch.blocked === true || (patch.role && patch.role !== 'admin'))) {
		throw new Error('cannot block or demote a server-defined admin');
	}
	const data = await load();
	const current = data.users[key];
	// Store only real, non-default models — the default is implicit, and admins
	// get everything regardless, so it never needs to be listed.
	const allowedModels =
		patch.allowedModels !== undefined
			? patch.allowedModels.filter((id) => MODEL_IDS.includes(id) && id !== DEFAULT_MODEL)
			: current?.allowedModels;
	data.users[key] = {
		role: patch.role ?? current?.role ?? 'user',
		blocked: patch.blocked ?? current?.blocked ?? false,
		maxDailyTokens:
			patch.maxDailyTokens !== undefined ? patch.maxDailyTokens : (current?.maxDailyTokens ?? null),
		...(allowedModels && allowedModels.length ? { allowedModels } : {}),
		sqlWrite: patch.sqlWrite ?? current?.sqlWrite ?? false,
		windmillWrite: patch.windmillWrite ?? current?.windmillWrite ?? false,
		addedBy: current?.addedBy ?? actor,
		addedAt: current?.addedAt ?? new Date().toISOString()
	};
	await save(data);
}

export async function removeAccessUser(username: string): Promise<void> {
	const key = username.trim().toLowerCase();
	if (isEnvAdmin(key)) throw new Error('cannot remove a server-defined admin');
	const data = await load();
	delete data.users[key];
	await save(data);
}

/**
 * Ordered list of model IDs a user may pick (default first). Admins — env or
 * role — get every model; everyone else gets the default plus their granted
 * extras. Always includes DEFAULT_MODEL, so the result is never empty.
 * Re-read per request, so a revoked grant takes effect on the next message.
 */
export async function resolveAllowedModels(username: string): Promise<string[]> {
	if ((await resolveRole(username)) === 'admin') return [...MODEL_IDS];
	const extra = new Set((await getAccessEntry(username))?.allowedModels ?? []);
	return MODEL_IDS.filter((id) => id === DEFAULT_MODEL || extra.has(id));
}

/** Validate a requested model against the user's allow-list; fall back to default. */
export async function resolveModel(username: string, requested: string): Promise<string> {
	const allowed = await resolveAllowedModels(username);
	return allowed.includes(requested) ? requested : DEFAULT_MODEL;
}

export async function getOrgSystemPrompt(): Promise<string> {
	return (await load()).orgSystemPrompt;
}

export async function setOrgSystemPrompt(text: string): Promise<void> {
	const data = await load();
	data.orgSystemPrompt = text.trim().slice(0, MAX_ORG_PROMPT);
	await save(data);
}

export async function getOrgKnowledge(): Promise<OrgKnowledgeEntry[]> {
	return (await load()).orgKnowledge;
}

export async function setOrgKnowledge(entries: unknown): Promise<OrgKnowledgeEntry[]> {
	const data = await load();
	data.orgKnowledge = sanitizeKnowledge(entries);
	await save(data);
	return data.orgKnowledge;
}

export async function getDepartments(): Promise<Department[]> {
	return (await load()).departments;
}

export async function setDepartments(departments: unknown): Promise<Department[]> {
	const data = await load();
	data.departments = sanitizeDepartments(departments);
	await save(data);
	return data.departments;
}

/** Enabled departments whose rule matches the given session profile. */
export async function departmentsForUser(
	profile: UserProfile | null | undefined
): Promise<Department[]> {
	if (!profile) return [];
	const { departments } = await load();
	return departments.filter((d) => d.enabled && matchesDept(d.match, profile));
}

/**
 * The text actually injected into a user's agent: the free-text standing
 * instructions, then each enabled company knowledge block, then the enabled
 * blocks of every department the user's profile matches. Concatenation follows
 * the stored order, so a given user's cached prompt prefix stays byte-stable
 * between turns as long as the knowledge base and their membership are unchanged.
 */
export async function getEffectiveOrgPrompt(profile?: UserProfile | null): Promise<string> {
	const data = await load();
	const parts: string[] = [];
	if (data.orgSystemPrompt.trim()) parts.push(data.orgSystemPrompt.trim());
	for (const e of data.orgKnowledge) {
		if (e.enabled && e.body.trim()) parts.push(blockText(e));
	}
	if (profile) {
		for (const dept of data.departments) {
			if (!dept.enabled || !matchesDept(dept.match, profile)) continue;
			for (const e of dept.knowledge) {
				if (e.enabled && e.body.trim()) parts.push(blockText(e, dept.name));
			}
		}
	}
	return parts.join('\n\n');
}

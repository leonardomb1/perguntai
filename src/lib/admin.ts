import { getToken } from '$lib/session';
import { matchesDept, type DeptMatch, type ProfileClaims } from './dept-rules';

/** Client for the admin endpoints (server enforces the admin role again). */

export interface AdminUser {
	username: string;
	role: 'admin' | 'builder' | 'user';
	blocked: boolean;
	maxDailyTokens: number | null;
	/** Extra models granted beyond the default (admins implicitly get all). */
	allowedModels?: string[];
	/** Lets the model write (INSERT/UPDATE/DELETE/CREATE) under this user's DB grants. */
	sqlWrite?: boolean;
	/** Lets the model mutate the Windmill workspace under this user's token. */
	windmillWrite?: boolean;
	addedBy: string;
	addedAt: string;
	envAdmin: boolean;
	usage: {
		today: number;
		month: number;
		todayRaw?: TokenBreakdown;
		monthRaw?: TokenBreakdown;
	};
}

/** Raw token split; `input` is total input (cached + uncached). */
export interface TokenBreakdown {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
}

function headers(): Record<string, string> {
	return { Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': 'application/json' };
}

/** Auth only — for multipart uploads the browser must set the Content-Type. */
function authHeader(): Record<string, string> {
	return { Authorization: `Bearer ${getToken() ?? ''}` };
}

/** A document in a shared (org/department) library. `scope` = 'org' | departmentId. */
export interface SharedDoc {
	id: string;
	name: string;
	uploadedAt: number;
	summary?: string;
}

export async function listOrgDocuments(scope: string): Promise<SharedDoc[]> {
	try {
		const res = await fetch(`/api/admin/org/documents?scope=${encodeURIComponent(scope)}`, {
			headers: authHeader()
		});
		if (!res.ok) return [];
		return (await res.json()).documents ?? [];
	} catch {
		return [];
	}
}

export async function uploadOrgDocument(
	scope: string,
	file: File,
	description: string
): Promise<{ ok: true; doc: SharedDoc } | { ok: false; error: string }> {
	const body = new FormData();
	body.append('scope', scope);
	body.append('file', file);
	if (description.trim()) body.append('description', description.trim());
	try {
		const res = await fetch('/api/admin/org/documents', { method: 'POST', headers: authHeader(), body });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
		return { ok: true, doc: data };
	} catch {
		return { ok: false, error: 'network' };
	}
}

export async function removeOrgDocument(scope: string, id: string): Promise<boolean> {
	const res = await fetch(
		`/api/admin/org/documents?scope=${encodeURIComponent(scope)}&id=${encodeURIComponent(id)}`,
		{ method: 'DELETE', headers: authHeader() }
	);
	return res.ok;
}

export async function listUsers(): Promise<{ users: AdminUser[]; openMode: boolean } | null> {
	try {
		const res = await fetch('/api/admin/users', { headers: headers() });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function addUser(username: string, role: 'admin' | 'user' = 'user'): Promise<string | null> {
	const res = await fetch('/api/admin/users', {
		method: 'POST',
		headers: headers(),
		body: JSON.stringify({ username, role })
	});
	if (res.ok) return null;
	return (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`;
}

export async function patchUser(
	username: string,
	patch: {
		role?: 'admin' | 'builder' | 'user';
		blocked?: boolean;
		maxDailyTokens?: number | null;
		allowedModels?: string[];
		sqlWrite?: boolean;
		windmillWrite?: boolean;
	}
): Promise<string | null> {
	const res = await fetch('/api/admin/users', {
		method: 'PATCH',
		headers: headers(),
		body: JSON.stringify({ username, ...patch })
	});
	if (res.ok) return null;
	return (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`;
}

export async function removeUser(username: string): Promise<string | null> {
	const res = await fetch(`/api/admin/users?username=${encodeURIComponent(username)}`, {
		method: 'DELETE',
		headers: headers()
	});
	if (res.ok) return null;
	return (await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`;
}

/** One titled block of the organization knowledge base (human-curated). */
export interface OrgKnowledgeEntry {
	id: string;
	title: string;
	body: string;
	enabled: boolean;
}

/** Membership rule for a department — user matches if ANY populated rule hits. */
export type { DeptMatch } from './dept-rules';

export interface Department {
	id: string;
	name: string;
	enabled: boolean;
	match: DeptMatch;
	knowledge: OrgKnowledgeEntry[];
}

/** The calling admin's own sign-in claims — seeds the rule editor. */
export interface CallerProfile {
	claims: ProfileClaims;
}

export interface OrgConfig {
	orgSystemPrompt: string;
	orgKnowledge: OrgKnowledgeEntry[];
	departments: Department[];
	you: CallerProfile;
}

export async function getOrg(): Promise<OrgConfig | null> {
	try {
		const res = await fetch('/api/admin/org', { headers: headers() });
		if (!res.ok) return null;
		const data = await res.json();
		return {
			orgSystemPrompt: data.orgSystemPrompt ?? '',
			orgKnowledge: Array.isArray(data.orgKnowledge) ? data.orgKnowledge : [],
			departments: Array.isArray(data.departments) ? data.departments : [],
			you: { claims: sanitizeClaims(data.you?.claims) }
		};
	} catch {
		return null;
	}
}

export async function saveOrg(
	payload: Partial<Pick<OrgConfig, 'orgSystemPrompt' | 'orgKnowledge' | 'departments'>>
): Promise<Pick<OrgConfig, 'orgSystemPrompt' | 'orgKnowledge' | 'departments'> | null> {
	const res = await fetch('/api/admin/org', {
		method: 'PUT',
		headers: headers(),
		body: JSON.stringify(payload)
	});
	if (!res.ok) return null;
	return await res.json().catch(() => null);
}

function sanitizeClaims(raw: unknown): ProfileClaims {
	if (typeof raw !== 'object' || !raw) return {};
	const out: ProfileClaims = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string');
	}
	return out;
}

/** The live "matches you" badge — the very same matcher the server enforces. */
export function matchesProfile(match: DeptMatch, you: CallerProfile): boolean {
	return matchesDept(match, you.claims);
}

/** 12345 → "12,3k", 2100000 → "2,1M" */
export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace('.', ',')}k`;
	return String(n);
}

/** Exact display for the limit input: 200000 → "200.000"; null → "". */
export function formatLimit(n: number | null): string {
	return n === null ? '' : n.toLocaleString('pt-BR');
}

/**
 * Parse a human token limit: "50k" → 50000, "1,5M" → 1500000, "200.000" /
 * "200,000" / "200000" → 200000. Empty (or 0) → null = unlimited.
 * Fractions only make sense with a k/M suffix ("1,5" alone is invalid).
 */
export function parseTokenLimit(raw: string): number | null | 'invalid' {
	const s = raw.trim().toLowerCase().replace(/\s|tokens?/g, '');
	if (!s || s === '∞' || s === '0') return null;
	const match = /^([0-9.,]+)([km])?$/.exec(s);
	if (!match) return 'invalid';
	const [, digits, suffix] = match;
	const grouped = /^\d{1,3}([.,]\d{3})+$/.test(digits);
	const value = grouped ? Number(digits.replace(/[.,]/g, '')) : Number(digits.replace(',', '.'));
	if (!Number.isFinite(value) || value < 0) return 'invalid';
	if (!suffix && !grouped && !Number.isInteger(value)) return 'invalid';
	const result = Math.round(value * (suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1));
	return result === 0 ? null : result;
}

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import type { Role } from './access';
import type {
	FlowAccess,
	FlowDeployment,
	FlowMeta,
	FlowProvenance,
	FlowRecord,
	FlowSpec,
	PublicFlowRecord
} from '$lib/flow-spec';

/**
 * Per-user versioned store for AI-composed flows, PLUS a global index that lets
 * admins see every flow and lets department members see their department's
 * flows. Flow RECORDS stay per-owner (DATA_DIR/flows/<owner>/<id>.json, with the
 * builder transcript in <id>.chat.json); a single DATA_DIR/flows/_index.json
 * holds one FlowMeta per flow (owner + departmentId) and is the listing source.
 * Versions are append-only; a flow always runs as its OWNER — department is an
 * access/organization layer, not a run-as change.
 */

const MAX_FLOWS = 200; // per owner
const MAX_VERSIONS = 100;

function flowsRoot(): string {
	return join(env.DATA_DIR ?? 'data', 'flows');
}
function userDir(username: string): string {
	return join(flowsRoot(), username.replace(/[^a-zA-Z0-9._-]/g, '_'));
}
function indexPath(): string {
	return join(flowsRoot(), '_index.json');
}

export function isValidFlowId(id: string): boolean {
	return /^[A-Za-z0-9-]{8,64}$/.test(id);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await readFile(path, 'utf8')) as T;
	} catch {
		return fallback;
	}
}

/** Back-fill fields missing on legacy records (departmentId → orphaned). */
function normalizeRecord(record: FlowRecord): FlowRecord {
	return { ...record, departmentId: record.departmentId ?? null };
}

function metaOf(record: FlowRecord): FlowMeta {
	const latest = record.versions.at(-1);
	return {
		id: record.id,
		name: record.name,
		owner: record.owner,
		departmentId: record.departmentId ?? null,
		updatedAt: latest ? new Date(latest.createdAt).getTime() : Date.now(),
		latestVersion: latest?.version ?? 0,
		activeVersion: record.activeVersion
	};
}

// --- global index (source of truth for listing) ---

async function readIndex(): Promise<FlowMeta[]> {
	return readJson<FlowMeta[]>(indexPath(), []);
}

// Serialize all index read-modify-writes (they span owners, so the per-user
// queue below is not enough).
let indexChain: Promise<unknown> = Promise.resolve();
function withIndex<T>(job: () => Promise<T>): Promise<T> {
	const next = indexChain.then(job, job);
	indexChain = next.catch(() => {});
	return next;
}

async function upsertIndexEntry(meta: FlowMeta): Promise<void> {
	await withIndex(async () => {
		const idx = await readIndex();
		await writeFile(indexPath(), JSON.stringify([meta, ...idx.filter((m) => m.id !== meta.id)]));
	});
}
async function removeIndexEntry(id: string): Promise<void> {
	await withIndex(async () => {
		const idx = await readIndex();
		await writeFile(indexPath(), JSON.stringify(idx.filter((m) => m.id !== id)));
	});
}

/** One-time migration: build the index by scanning every owner's flow records. */
async function buildIndex(): Promise<void> {
	const root = flowsRoot();
	const entries: FlowMeta[] = [];
	const dirents = await readdir(root, { withFileTypes: true }).catch(() => []);
	for (const d of dirents) {
		if (!d.isDirectory()) continue;
		let files: string[] = [];
		try {
			files = await readdir(join(root, d.name));
		} catch {
			continue;
		}
		for (const f of files) {
			if (!f.endsWith('.json') || f === 'index.json' || f.endsWith('.chat.json')) continue;
			const id = f.slice(0, -5);
			if (!isValidFlowId(id)) continue;
			const record = await readJson<FlowRecord | null>(join(root, d.name, f), null);
			if (record && record.id === id) entries.push(metaOf(normalizeRecord(record)));
		}
	}
	entries.sort((a, b) => b.updatedAt - a.updatedAt);
	await mkdir(root, { recursive: true });
	await writeFile(indexPath(), JSON.stringify(entries));
}

let indexReady: Promise<void> | null = null;
async function ensureIndex(): Promise<void> {
	if (!indexReady)
		indexReady = (async () => {
			try {
				await stat(indexPath());
			} catch {
				await buildIndex();
			}
		})();
	return indexReady;
}

// --- record read/write ---

export async function loadFlow(username: string, id: string): Promise<FlowRecord | null> {
	if (!isValidFlowId(id)) return null;
	const record = await readJson<FlowRecord | null>(join(userDir(username), `${id}.json`), null);
	return record ? normalizeRecord(record) : null;
}

/** Load a flow by id alone (owner resolved via the index) — for cross-owner reads. */
export async function loadFlowById(id: string): Promise<FlowRecord | null> {
	if (!isValidFlowId(id)) return null;
	await ensureIndex();
	const entry = (await readIndex()).find((m) => m.id === id);
	return entry ? loadFlow(entry.owner, id) : null;
}

/** Browser-safe view: the deployment's secret and sealed credentials never leave the server. */
export function publicRecord(record: FlowRecord): PublicFlowRecord {
	if (!record.deployment) return record;
	const { secret: _s, sealedCreds: _c, ...deployment } = record.deployment;
	return { ...record, deployment };
}

async function persist(username: string, record: FlowRecord): Promise<void> {
	await mkdir(userDir(username), { recursive: true });
	await writeFile(join(userDir(username), `${record.id}.json`), JSON.stringify(record));
	await upsertIndexEntry(metaOf(record));
}

// Serialize read-modify-write per owner so two concurrent saves can't drop a
// version.
const queues = new Map<string, Promise<unknown>>();
function enqueue<T>(username: string, job: () => Promise<T>): Promise<T> {
	const next = (queues.get(username) ?? Promise.resolve()).then(job, job);
	queues.set(
		username,
		next.catch(() => {})
	);
	return next;
}

export async function listAllFlows(): Promise<FlowMeta[]> {
	await ensureIndex();
	return readIndex();
}

export async function listFlows(username: string): Promise<FlowMeta[]> {
	return (await listAllFlows()).filter((m) => m.owner === username);
}

/** How the requesting user relates to a flow (drives view/run vs edit rights). */
export function resolveFlowAccess(
	entry: { owner: string; departmentId: string | null },
	username: string,
	role: Role,
	matchedDeptIds: Set<string>
): FlowAccess {
	if (role === 'admin') return 'admin';
	if (entry.owner === username) return 'owner';
	if (entry.departmentId && matchedDeptIds.has(entry.departmentId)) return 'department';
	return 'none';
}

export interface SaveFlowInput {
	/** Omitted = create a new flow; present = append a version to an existing one. */
	flowId?: string;
	name: string;
	spec: FlowSpec;
	provenance: FlowProvenance;
	/** Department for a NEW flow; ignored when editing (governed via assignDepartment). */
	departmentId?: string | null;
}

export interface SaveFlowResult {
	id: string;
	version: number;
	created: boolean;
}

export async function saveFlowVersion(
	username: string,
	input: SaveFlowInput
): Promise<SaveFlowResult | { error: 'unknown_flow' | 'too_many_flows' }> {
	await ensureIndex();
	return enqueue(username, async () => {
		let record: FlowRecord;
		let created = false;
		if (input.flowId) {
			const existing = await loadFlow(username, input.flowId);
			if (!existing) return { error: 'unknown_flow' as const };
			record = existing;
		} else {
			const mine = (await listAllFlows()).filter((m) => m.owner === username);
			if (mine.length >= MAX_FLOWS) return { error: 'too_many_flows' as const };
			created = true;
			record = {
				id: randomUUID(),
				owner: username,
				name: input.name,
				departmentId: input.departmentId ?? null,
				createdAt: new Date().toISOString(),
				activeVersion: null,
				versions: []
			};
		}

		const version = (record.versions.at(-1)?.version ?? 0) + 1;
		record.name = input.name;
		record.versions.push({
			version,
			createdAt: new Date().toISOString(),
			spec: input.spec,
			provenance: input.provenance
		});
		while (record.versions.length > MAX_VERSIONS) {
			const oldest = record.versions[0];
			if (oldest.version === record.activeVersion) break;
			record.versions.shift();
		}
		await persist(username, record);
		return { id: record.id, version, created };
	});
}

/** Record a live Windmill deployment; the deployed version becomes active. */
export async function setDeployment(
	username: string,
	id: string,
	deployment: FlowDeployment
): Promise<FlowRecord | null> {
	await ensureIndex();
	return enqueue(username, async () => {
		const record = await loadFlow(username, id);
		if (!record) return null;
		record.deployment = deployment;
		record.activeVersion = deployment.deployedVersion;
		await persist(username, record);
		return record;
	});
}

/** Back to draft: the Windmill side is gone, so no version is active. */
export async function clearDeployment(username: string, id: string): Promise<FlowRecord | null> {
	await ensureIndex();
	return enqueue(username, async () => {
		const record = await loadFlow(username, id);
		if (!record) return null;
		delete record.deployment;
		record.activeVersion = null;
		await persist(username, record);
		return record;
	});
}

/** Set/clear a flow's department (owner resolved via the index). */
export async function assignDepartment(
	id: string,
	departmentId: string | null
): Promise<FlowRecord | null> {
	if (!isValidFlowId(id)) return null;
	await ensureIndex();
	const entry = (await readIndex()).find((m) => m.id === id);
	if (!entry) return null;
	return enqueue(entry.owner, async () => {
		const record = await loadFlow(entry.owner, id);
		if (!record) return null;
		record.departmentId = departmentId;
		await persist(entry.owner, record);
		return record;
	});
}

export async function deleteFlow(username: string, id: string): Promise<boolean> {
	if (!isValidFlowId(id)) return false;
	await ensureIndex();
	return enqueue(username, async () => {
		const record = await loadFlow(username, id);
		if (!record) return false;
		await rm(join(userDir(username), `${id}.json`), { force: true });
		await rm(join(userDir(username), `${id}.chat.json`), { force: true });
		await removeIndexEntry(id);
		return true;
	});
}

/**
 * The builder-chat transcript for one flow, kept in a sidecar so editing can
 * resume later. Opaque UIMessage[] — the server only stores and returns it.
 */
export async function loadFlowChat(username: string, id: string): Promise<unknown[]> {
	if (!isValidFlowId(id)) return [];
	return readJson<unknown[]>(join(userDir(username), `${id}.chat.json`), []);
}

export async function saveFlowChat(username: string, id: string, messages: unknown[]): Promise<void> {
	if (!isValidFlowId(id) || !Array.isArray(messages)) return;
	await mkdir(userDir(username), { recursive: true });
	await writeFile(join(userDir(username), `${id}.chat.json`), JSON.stringify(messages));
}

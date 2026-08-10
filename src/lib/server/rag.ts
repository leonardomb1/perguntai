import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';

/**
 * Per-user document store for RAG, persisted as JSON on the server filesystem
 * (DATA_DIR, default ./data). Retrieval is lexical BM25 over ~1500-char
 * chunks — dependency-free and good enough for docs/notes; swap `search()`
 * for an embedding-based retriever later without touching callers.
 */

const MAX_DOCS_PER_USER = 50;
const MAX_SHEET_ROWS = 20_000;
const MAX_TEXT_ROWS = 2_000; // rows rendered into BM25-searchable text

export interface SheetData {
	name: string;
	columns: string[];
	rows: Record<string, unknown>[];
	truncated: boolean;
	/** Inferred type per column (number/date/boolean/text) — helps analysis. */
	columnTypes?: Record<string, string>;
}

export interface StoredDoc {
	id: string;
	name: string;
	uploadedAt: number;
	/** Conversation the doc was attached in (per-user store); '' for shared docs. */
	conversationId: string;
	chunks: string[];
	/** Present for tabular uploads (CSV/Excel) — structured data for analysis. */
	sheets?: SheetData[];
	/** One-line description for the manifest (shared library docs). */
	summary?: string;
}

function storePath(username: string): string {
	// Usernames come from LDAP — sanitize before touching the filesystem.
	const safe = username.replace(/[^a-zA-Z0-9._-]/g, '_');
	return join(env.DATA_DIR ?? 'data', 'rag', `${safe}.json`);
}

async function readStore(username: string): Promise<StoredDoc[]> {
	try {
		return JSON.parse(await readFile(storePath(username), 'utf8'));
	} catch {
		return [];
	}
}

async function writeStore(username: string, docs: StoredDoc[]): Promise<void> {
	const path = storePath(username);
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, JSON.stringify(docs));
}

/**
 * Shared (admin-curated) document libraries, scoped to the whole organization
 * (`org`) or one department (`dept-<deptId>`). Same StoredDoc/chunking/BM25 as
 * the per-user store — just a different file, kept apart under _shared/ so it
 * never collides with an LDAP username.
 */
const MAX_SHARED_DOCS = 100;

function sharedStorePath(scope: string): string {
	const safe = scope.replace(/[^a-zA-Z0-9._-]/g, '_');
	return join(env.DATA_DIR ?? 'data', 'rag', '_shared', `${safe}.json`);
}
async function readSharedStore(scope: string): Promise<StoredDoc[]> {
	try {
		return JSON.parse(await readFile(sharedStorePath(scope), 'utf8'));
	} catch {
		return [];
	}
}
async function writeSharedStore(scope: string, docs: StoredDoc[]): Promise<void> {
	const path = sharedStorePath(scope);
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, JSON.stringify(docs));
}

export const orgScope = 'org';
export const deptScope = (deptId: string) => `dept-${deptId}`;

// --- chunking ---

const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;

export function chunkText(text: string): string[] {
	const clean = text.replace(/\r\n/g, '\n').trim();
	if (!clean) return [];
	const chunks: string[] = [];
	let start = 0;
	while (start < clean.length) {
		let end = Math.min(start + CHUNK_SIZE, clean.length);
		// Prefer to break on a paragraph or sentence boundary near the end.
		if (end < clean.length) {
			const slice = clean.slice(start, end);
			const breakAt = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '));
			if (breakAt > CHUNK_SIZE * 0.5) end = start + breakAt + 1;
		}
		chunks.push(clean.slice(start, end).trim());
		if (end >= clean.length) break;
		start = end - CHUNK_OVERLAP;
	}
	return chunks.filter((c) => c.length > 0);
}

// --- CRUD ---

export async function listDocs(
	username: string,
	conversationId: string
): Promise<{ id: string; name: string; uploadedAt: number; sheets?: string[] }[]> {
	return (await readStore(username))
		.filter((d) => d.conversationId === conversationId)
		.map(({ id, name, uploadedAt, sheets }) => ({
		id,
		name,
		uploadedAt,
			...(sheets ? { sheets: sheets.map((s) => s.name) } : {})
		}));
}

export async function addDoc(
	username: string,
	conversationId: string,
	name: string,
	content: string
): Promise<StoredDoc> {
	const docs = await readStore(username);
	if (docs.length >= MAX_DOCS_PER_USER) {
		throw new Error(`Document limit reached (${MAX_DOCS_PER_USER})`);
	}
	const doc: StoredDoc = {
		id: randomUUID(),
		name,
		uploadedAt: Date.now(),
		conversationId,
		chunks: chunkText(content)
	};
	if (doc.chunks.length === 0) throw new Error('Document contains no extractable text');
	docs.push(doc);
	await writeStore(username, docs);
	return doc;
}

function boundSheets(sheets: SheetData[]): SheetData[] {
	return sheets.map((s) => ({
		...s,
		truncated: s.truncated || s.rows.length > MAX_SHEET_ROWS,
		rows: s.rows.slice(0, MAX_SHEET_ROWS)
	}));
}

/** Text rendering of the first rows so a spreadsheet is BM25-searchable; a
 *  header line with the inferred column types gives the AI extra grounding. */
function sheetsToText(sheets: SheetData[]): string {
	return sheets
		.map((s) => {
			const types = s.columnTypes
				? `(${s.columns.map((c) => `${c}: ${s.columnTypes![c] ?? 'text'}`).join(', ')})\n`
				: '';
			return (
				`Sheet: ${s.name}\n${types}${s.columns.join('\t')}\n` +
				s.rows
					.slice(0, MAX_TEXT_ROWS)
					.map((r) => s.columns.map((c) => String(r[c] ?? '')).join('\t'))
					.join('\n')
			);
		})
		.join('\n\n');
}

/** Build a tabular StoredDoc: structured sheets (for analysis) + searchable text. */
function makeTabularDoc(
	name: string,
	conversationId: string,
	sheets: SheetData[],
	summary?: string
): StoredDoc {
	const bounded = boundSheets(sheets);
	if (bounded.every((s) => s.rows.length === 0)) throw new Error('Spreadsheet contains no data rows');
	return {
		id: randomUUID(),
		name,
		uploadedAt: Date.now(),
		conversationId,
		chunks: chunkText(sheetsToText(bounded)),
		sheets: bounded,
		...(summary?.trim() ? { summary: summary.trim().slice(0, 200) } : {})
	};
}

/**
 * Stores a tabular upload (CSV/Excel): structured sheets for analysis
 * (previewTable, runPython) plus a text rendering so it is BM25-searchable.
 */
export async function addTabularDoc(
	username: string,
	conversationId: string,
	name: string,
	sheets: SheetData[]
): Promise<StoredDoc> {
	const docs = await readStore(username);
	if (docs.length >= MAX_DOCS_PER_USER) {
		throw new Error(`Document limit reached (${MAX_DOCS_PER_USER})`);
	}
	const doc = makeTabularDoc(name, conversationId, sheets);
	docs.push(doc);
	await writeStore(username, docs);
	return doc;
}

/** Every tabular doc the user can reach: conversation attachments + org +
 *  their departments' shared libraries. */
async function gatherTabularDocs(
	username: string,
	conversationId: string,
	depts: { id: string; name: string }[]
): Promise<StoredDoc[]> {
	const out: StoredDoc[] = [];
	for (const d of await readStore(username))
		if (d.sheets?.length && d.conversationId === conversationId) out.push(d);
	for (const d of await readSharedStore(orgScope)) if (d.sheets?.length) out.push(d);
	for (const dep of depts)
		for (const d of await readSharedStore(deptScope(dep.id))) if (d.sheets?.length) out.push(d);
	return out;
}

/** Fuzzy lookup of a table (conversation or a shared library): document by name, then sheet. */
export async function getSheet(
	username: string,
	conversationId: string,
	depts: { id: string; name: string }[],
	documentName: string,
	sheetName?: string
): Promise<{ document: string; sheet: SheetData } | null> {
	const docs = await gatherTabularDocs(username, conversationId, depts);
	const needle = documentName.toLowerCase();
	const doc =
		docs.find((d) => d.name.toLowerCase() === needle) ??
		docs.find((d) => d.name.toLowerCase().includes(needle));
	if (!doc?.sheets) return null;
	const sheet = sheetName
		? doc.sheets.find((s) => s.name.toLowerCase() === sheetName.toLowerCase())
		: doc.sheets[0];
	return sheet ? { document: doc.name, sheet } : null;
}

/** Names of tabular documents (with their sheets), for not-found error messages. */
export async function listTables(
	username: string,
	conversationId: string,
	depts: { id: string; name: string }[]
): Promise<string[]> {
	return (await gatherTabularDocs(username, conversationId, depts)).map(
		(d) => `${d.name} (${d.sheets!.map((s) => s.name).join(', ')})`
	);
}

/** Cascade: called when a conversation is deleted or evicted. */
export async function removeDocsForConversation(
	username: string,
	conversationId: string
): Promise<void> {
	const docs = await readStore(username);
	const kept = docs.filter((d) => d.conversationId !== conversationId);
	if (kept.length !== docs.length) await writeStore(username, kept);
}

export async function removeDoc(username: string, id: string): Promise<void> {
	const docs = await readStore(username);
	await writeStore(
		username,
		docs.filter((d) => d.id !== id)
	);
}

// --- shared libraries (org / department) ---

export async function addSharedDoc(
	scope: string,
	name: string,
	content: string,
	summary?: string
): Promise<StoredDoc> {
	const docs = await readSharedStore(scope);
	if (docs.length >= MAX_SHARED_DOCS) throw new Error(`Document limit reached (${MAX_SHARED_DOCS})`);
	const chunks = chunkText(content);
	if (chunks.length === 0) throw new Error('Document contains no extractable text');
	const doc: StoredDoc = {
		id: randomUUID(),
		name,
		uploadedAt: Date.now(),
		conversationId: '',
		chunks,
		...(summary?.trim() ? { summary: summary.trim().slice(0, 200) } : {})
	};
	docs.push(doc);
	await writeSharedStore(scope, docs);
	return doc;
}

export async function addSharedTabularDoc(
	scope: string,
	name: string,
	sheets: SheetData[],
	summary?: string
): Promise<StoredDoc> {
	const docs = await readSharedStore(scope);
	if (docs.length >= MAX_SHARED_DOCS) throw new Error(`Document limit reached (${MAX_SHARED_DOCS})`);
	const doc = makeTabularDoc(name, '', sheets, summary);
	docs.push(doc);
	await writeSharedStore(scope, docs);
	return doc;
}

export async function listSharedDocs(
	scope: string
): Promise<{ id: string; name: string; uploadedAt: number; summary?: string }[]> {
	return (await readSharedStore(scope)).map(({ id, name, uploadedAt, summary }) => ({
		id,
		name,
		uploadedAt,
		...(summary ? { summary } : {})
	}));
}

export async function removeSharedDoc(scope: string, id: string): Promise<void> {
	const docs = await readSharedStore(scope);
	await writeSharedStore(
		scope,
		docs.filter((d) => d.id !== id)
	);
}

/** Small list of shared docs (name + summary + kind) for the agent's system prompt. */
export async function sharedManifest(
	depts: { id: string; name: string }[]
): Promise<{ source: string; name: string; summary: string; tabular: boolean }[]> {
	const out: { source: string; name: string; summary: string; tabular: boolean }[] = [];
	const add = (source: string, d: StoredDoc) =>
		out.push({ source, name: d.name, summary: d.summary ?? '', tabular: !!d.sheets?.length });
	for (const d of await readSharedStore(orgScope)) add('organization', d);
	for (const dep of depts) for (const d of await readSharedStore(deptScope(dep.id))) add(dep.name, d);
	return out;
}

// --- BM25 retrieval ---

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '') // strip accents (pt-BR friendly)
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 1);
}

export interface SearchHit {
	document: string;
	excerpt: string;
	score: number;
	/** Which library the hit came from: 'conversation' | 'organization' | a dept name. */
	source: string;
}

interface CorpusEntry {
	document: string;
	source: string;
	chunk: string;
}

/** BM25 over a pre-gathered set of (document, source, chunk) entries. */
function rankChunks(corpus: CorpusEntry[], query: string, topK: number): SearchHit[] {
	if (corpus.length === 0) return [];
	const queryTerms = [...new Set(tokenize(query))];
	const tokenized = corpus.map((c) => tokenize(c.chunk));
	const avgLen = tokenized.reduce((s, t) => s + t.length, 0) / tokenized.length;

	const df = new Map<string, number>();
	for (const term of queryTerms) {
		df.set(term, tokenized.filter((tokens) => tokens.includes(term)).length);
	}

	const k1 = 1.5;
	const b = 0.75;
	const scores = tokenized.map((tokens, i) => {
		let score = 0;
		for (const term of queryTerms) {
			const n = df.get(term) ?? 0;
			if (n === 0) continue;
			const idf = Math.log(1 + (corpus.length - n + 0.5) / (n + 0.5));
			const tf = tokens.filter((t) => t === term).length;
			score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * tokens.length) / avgLen));
		}
		return { ...corpus[i], score };
	});

	return scores
		.filter((s) => s.score > 0)
		.sort((a, b2) => b2.score - a.score)
		.slice(0, topK)
		.map(({ document, source, chunk, score }) => ({
			document,
			source,
			excerpt: chunk,
			score: Math.round(score * 100) / 100
		}));
}

/** Conversation-scoped search (per-user store only). */
export async function search(
	username: string,
	conversationId: string,
	query: string,
	topK = 5
): Promise<SearchHit[]> {
	const docs = (await readStore(username)).filter((d) => d.conversationId === conversationId);
	return rankChunks(
		docs.flatMap((d) => d.chunks.map((chunk) => ({ document: d.name, source: 'conversation', chunk }))),
		query,
		topK
	);
}

/**
 * Search across every library the user can see: their conversation attachments,
 * the organization library, and each department they belong to. Hits are labeled
 * by source so the model can cite where a passage came from.
 */
export async function searchAllDocuments(
	username: string,
	conversationId: string,
	depts: { id: string; name: string }[],
	query: string,
	topK = 6
): Promise<SearchHit[]> {
	const corpus: CorpusEntry[] = [];
	for (const d of (await readStore(username)).filter((d) => d.conversationId === conversationId))
		for (const chunk of d.chunks) corpus.push({ document: d.name, source: 'conversation', chunk });
	for (const d of await readSharedStore(orgScope))
		for (const chunk of d.chunks) corpus.push({ document: d.name, source: 'organization', chunk });
	for (const dep of depts)
		for (const d of await readSharedStore(deptScope(dep.id)))
			for (const chunk of d.chunks) corpus.push({ document: d.name, source: dep.name, chunk });
	return rankChunks(corpus, query, topK);
}

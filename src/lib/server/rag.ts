import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import {
	embedQuery,
	embedTexts,
	embeddingsConfigured,
	embeddingsModel,
	similarity,
	unpackVector
} from './embeddings';

/**
 * Per-user document store for RAG, persisted as JSON on the server filesystem
 * (DATA_DIR, default ./data). Retrieval is hybrid: lexical BM25 over ~1500-char
 * chunks — markdown-aware, so a chunk knows which chapter it came from — fused
 * (reciprocal rank) with cosine over embeddings when EMBEDDINGS_BASE_URL is
 * configured. Without it, or for documents stored before it was, BM25 alone
 * carries the search, so retrieval never breaks — it just gets sharper.
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
	/**
	 * One packed unit vector per chunk (see ./embeddings), absent when the doc
	 * was stored without an embedding provider. Parallel to `chunks`.
	 */
	vectors?: string[];
	/** Which model produced `vectors` — a different one at search time ignores them. */
	embModel?: string;
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

/** Size-based splitting, breaking on a paragraph or sentence boundary when near. */
function splitBySize(clean: string): string[] {
	if (!clean) return [];
	const chunks: string[] = [];
	let start = 0;
	while (start < clean.length) {
		let end = Math.min(start + CHUNK_SIZE, clean.length);
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

interface MdSection {
	/** Heading trail down to this section, e.g. ['Compras', 'Aprovação']. */
	path: string[];
	body: string;
}

/**
 * Split markdown into sections at ATX headings, keeping the heading trail.
 * Fenced code blocks are opaque — a `#` inside ``` is not a heading.
 */
function markdownSections(clean: string): MdSection[] {
	const sections: MdSection[] = [];
	const path: { level: number; title: string; hasBody: boolean }[] = [];
	let body: string[] = [];
	let inFence = false;

	const push = () => {
		const text = body.join('\n').trim();
		if (text) {
			sections.push({ path: path.map((h) => h.title), body: text });
			// The text belongs to every ancestor, so all of them now "have body".
			for (const h of path) h.hasBody = true;
		}
		body = [];
	};

	for (const line of clean.split('\n')) {
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		const heading = inFence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading) {
			push();
			const level = heading[1].length;
			// A same-level sibling replaces the top of the path — unless that top
			// never got any body text: consecutive headings ('# Doc 05' directly
			// over '# Fonte: …') act as one stacked title, so the second nests
			// under the first instead of erasing it from every chunk's trail.
			while (path.length) {
				const top = path[path.length - 1];
				if (top.level > level || (top.level === level && top.hasBody)) path.pop();
				else break;
			}
			path.push({ level, title: heading[2].trim(), hasBody: false });
		} else {
			body.push(line);
		}
	}
	push();
	return sections;
}

/**
 * Chunk a document for retrieval. Markdown with real structure is split along
 * its headings, each chunk prefixed with the heading trail — so "item 4.2.1"
 * still knows which chapter it belongs to when it surfaces alone; a tiny
 * section rides with its heading rather than becoming a fragment. Anything
 * else falls back to plain size-based splitting.
 */
export function chunkText(text: string): string[] {
	const clean = text.replace(/\r\n/g, '\n').trim();
	if (!clean) return [];

	const sections = markdownSections(clean);
	// Structure has to be real to be useful: a lone '# Title' is not a book.
	if (sections.filter((sec) => sec.path.length > 0).length < 2) {
		return splitBySize(clean);
	}

	const chunks: string[] = [];
	for (const section of sections) {
		const trail = section.path.length ? `[${section.path.join(' > ')}]\n` : '';
		for (const piece of splitBySize(section.body)) {
			chunks.push(`${trail}${piece}`);
		}
	}
	return chunks;
}

/**
 * Best-effort vectors for a doc's chunks. Failure (no provider, provider down)
 * degrades the document to lexical-only retrieval rather than failing the
 * upload — the text is the point; the vectors are an upgrade.
 */
async function tryEmbed(doc: StoredDoc): Promise<void> {
	if (!embeddingsConfigured()) return;
	try {
		doc.vectors = await embedTexts(doc.chunks);
		doc.embModel = embeddingsModel();
	} catch (err) {
		console.warn(`rag: could not embed "${doc.name}" — stored for lexical search only`, err);
	}
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
	await tryEmbed(doc);
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
	await tryEmbed(doc);
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
	/** Packed unit vector for this chunk, when its document was embedded. */
	vector?: string;
}

/** BM25 scores over the corpus, aligned by index. */
function bm25Scores(corpus: CorpusEntry[], query: string): number[] {
	const queryTerms = [...new Set(tokenize(query))];
	const tokenized = corpus.map((c) => tokenize(c.chunk));
	const avgLen = tokenized.reduce((s, t) => s + t.length, 0) / tokenized.length;

	const df = new Map<string, number>();
	for (const term of queryTerms) {
		df.set(term, tokenized.filter((tokens) => tokens.includes(term)).length);
	}

	const k1 = 1.5;
	const b = 0.75;
	return tokenized.map((tokens) => {
		let score = 0;
		for (const term of queryTerms) {
			const n = df.get(term) ?? 0;
			if (n === 0) continue;
			const idf = Math.log(1 + (corpus.length - n + 0.5) / (n + 0.5));
			const tf = tokens.filter((t) => t === term).length;
			score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * tokens.length) / avgLen));
		}
		return score;
	});
}

/** Indexes of the top `k` positive scores, best first. */
function topIndexes(scores: number[], k: number): number[] {
	return scores
		.map((score, i) => ({ score, i }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, k)
		.map((x) => x.i);
}

/** Reciprocal-rank fusion constant — the standard 60 from the RRF paper. */
const RRF_K = 60;
/** How deep each ranking contributes to the fusion. */
const FUSE_DEPTH = 30;

/**
 * Rank the corpus for a query: BM25 always; cosine over embedded chunks when a
 * provider is configured, fused by reciprocal rank. Exact terms (codes, SKUs,
 * section numbers) keep their lexical bite while paraphrases still hit — and a
 * corpus with no vectors, or an unreachable provider, is plain BM25 as before.
 */
async function rankChunks(
	corpus: CorpusEntry[],
	query: string,
	topK: number
): Promise<SearchHit[]> {
	if (corpus.length === 0) return [];

	const lexical = bm25Scores(corpus, query);
	const lexicalTop = topIndexes(lexical, FUSE_DEPTH);

	let semanticTop: number[] = [];
	if (embeddingsConfigured() && corpus.some((c) => c.vector)) {
		try {
			const q = await embedQuery(query);
			const semantic = corpus.map((c) => (c.vector ? similarity(q, unpackVector(c.vector)) : 0));
			semanticTop = topIndexes(semantic, FUSE_DEPTH);
		} catch (err) {
			console.warn('rag: query embedding failed — lexical results only', err);
		}
	}

	const fused = new Map<number, number>();
	for (const ranking of [lexicalTop, semanticTop]) {
		ranking.forEach((index, rank) => {
			fused.set(index, (fused.get(index) ?? 0) + 1 / (RRF_K + rank + 1));
		});
	}

	return [...fused.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, topK)
		.map(([index, score]) => ({
			document: corpus[index].document,
			source: corpus[index].source,
			excerpt: corpus[index].chunk,
			score: Math.round(score * 1000) / 1000
		}));
}

/** A document's chunks as corpus entries, with vectors when the model matches. */
function entriesOf(doc: StoredDoc, source: string): CorpusEntry[] {
	const usable = doc.vectors?.length === doc.chunks.length && doc.embModel === embeddingsModel();
	return doc.chunks.map((chunk, i) => ({
		document: doc.name,
		source,
		chunk,
		...(usable ? { vector: doc.vectors![i] } : {})
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
		docs.flatMap((d) => entriesOf(d, 'conversation')),
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
		corpus.push(...entriesOf(d, 'conversation'));
	for (const d of await readSharedStore(orgScope)) corpus.push(...entriesOf(d, 'organization'));
	for (const dep of depts)
		for (const d of await readSharedStore(deptScope(dep.id))) corpus.push(...entriesOf(d, dep.name));
	return rankChunks(corpus, query, topK);
}

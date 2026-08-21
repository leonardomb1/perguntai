import { env } from '$env/dynamic/private';

/**
 * Embedding client for any OpenAI-compatible `/embeddings` endpoint — Azure
 * OpenAI/Foundry, Ollama, vLLM, OpenAI itself. Configured entirely by env
 * (see .env.example); with EMBEDDINGS_BASE_URL unset the app runs exactly as
 * before, on lexical retrieval alone.
 *
 * Vectors are L2-normalized here once, so similarity later is a plain dot
 * product. Storage is base64-encoded Float32 — a 1024-dim vector costs ~5.5 KB
 * in the JSON store instead of ~20 KB as a number array, and parses for free.
 */

const BATCH = 128;
/** Character budget per request, under typical 8k-token embedding limits. */
const BATCH_CHARS = 100_000;

export function embeddingsConfigured(): boolean {
	return !!env.EMBEDDINGS_BASE_URL;
}

/** Identifies which model produced a stored vector, so a swap re-embeds. */
export function embeddingsModel(): string {
	return env.EMBEDDINGS_MODEL || 'text-embedding-3-small';
}

function timeoutMs(): number {
	const n = Number(env.EMBEDDINGS_TIMEOUT_MS || 30_000);
	return Number.isFinite(n) && n > 0 ? n : 30_000;
}

function normalize(vector: number[]): Float32Array {
	let sq = 0;
	for (const v of vector) sq += v * v;
	const inv = sq > 0 ? 1 / Math.sqrt(sq) : 0;
	const out = new Float32Array(vector.length);
	for (let i = 0; i < vector.length; i++) out[i] = vector[i] * inv;
	return out;
}

export function packVector(vector: Float32Array): string {
	return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}

export function unpackVector(packed: string): Float32Array {
	const buf = Buffer.from(packed, 'base64');
	return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Dot product of unit vectors = cosine similarity in [-1, 1]. */
export function similarity(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) return 0;
	let dot = 0;
	for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
	return dot;
}

const MAX_RETRIES = 6;
/** Backoff ceiling — a Retry-After beyond this means the quota is the problem. */
const MAX_RETRY_WAIT_MS = 65_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function requestEmbeddings(inputs: string[]): Promise<Float32Array[]> {
	const base = env.EMBEDDINGS_BASE_URL!.replace(/\/+$/, '');
	const key = env.EMBEDDINGS_API_KEY ?? '';

	let res: Response;
	for (let attempt = 0; ; attempt++) {
		res = await fetch(`${base}/embeddings`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				// Both header styles: Azure wants api-key, everyone else a bearer.
				...(key ? { authorization: `Bearer ${key}`, 'api-key': key } : {})
			},
			body: JSON.stringify({ model: embeddingsModel(), input: inputs }),
			signal: AbortSignal.timeout(timeoutMs())
		});
		// Azure S0 quotas throttle a large document mid-way as a matter of course;
		// waiting out Retry-After is normal operation, not an error. 5xx gets the
		// same patience, capped, so a blip does not un-embed a 1,600-chunk upload.
		if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
			const after = Number(res.headers.get('retry-after'));
			const wait = Math.min(
				Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * 2 ** attempt,
				MAX_RETRY_WAIT_MS
			);
			await res.body?.cancel().catch(() => {});
			await sleep(wait);
			continue;
		}
		break;
	}
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`embeddings: ${res.status} ${detail.slice(0, 200)}`);
	}

	const data = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
	if (!Array.isArray(data.data) || data.data.length !== inputs.length) {
		throw new Error('embeddings: response length does not match input');
	}
	const out = new Array<Float32Array>(inputs.length);
	for (const item of data.data) out[item.index] = normalize(item.embedding);
	return out;
}

/**
 * Embed a batch of texts, packed for storage. Batches by count and by size so
 * one oversized chunk cannot fail the whole document. Throws on provider
 * errors — callers decide whether that degrades to lexical-only or aborts.
 */
export async function embedTexts(texts: string[]): Promise<string[]> {
	const out = new Array<string>(texts.length);
	let start = 0;
	while (start < texts.length) {
		let end = start;
		let chars = 0;
		while (end < texts.length && end - start < BATCH && chars < BATCH_CHARS) {
			chars += texts[end].length;
			end++;
		}
		const vectors = await requestEmbeddings(texts.slice(start, end));
		for (let i = 0; i < vectors.length; i++) out[start + i] = packVector(vectors[i]);
		start = end;
	}
	return out;
}

export async function embedQuery(text: string): Promise<Float32Array> {
	const [vector] = await requestEmbeddings([text]);
	return vector;
}

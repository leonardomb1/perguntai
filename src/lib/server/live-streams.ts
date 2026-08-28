/**
 * In-memory registry of live chat runs, making streams RESUMABLE.
 *
 * Why: on mobile, a network switch (Wi-Fi ↔ 4G) or app backgrounding kills the
 * SSE connection mid-run — heartbeats can't survive an IP change. Losing the
 * socket used to abort the agent and lose the whole (CPU-expensive) response.
 * Now the run is decoupled from the connection: the UI stream is teed into a
 * per-conversation buffer while it streams to the client, and the client can
 * reconnect with GET /api/chat/{id}/stream (the AI SDK's resumeStream()
 * protocol) to replay the buffer and follow the still-live tail.
 *
 * Single-process only (adapter-node) — state lives in this module. Entries are
 * dropped 5 min after completion (grace for late reconnects) or 30 min after
 * the last activity (safety for leaks); one run per conversation, a new send
 * aborts the previous run.
 */

interface LiveEntry {
	chunks: Uint8Array[];
	done: boolean;
	touchedAt: number;
	abort: AbortController;
	timeout: ReturnType<typeof setTimeout>;
	/** Live followers of an in-flight stream; called with null when it ends. */
	listeners: Set<(chunk: Uint8Array | null) => void>;
}

const streams = new Map<string, LiveEntry>();

const DONE_TTL_MS = 5 * 60_000;
const LIVE_TTL_MS = 30 * 60_000;
/** Hard cap on a single run — the agent can't be aborted by disconnects
 *  anymore, so something must bound a wedged run. */
const RUN_TIMEOUT_MS = 20 * 60_000;

// Module-level sweeper (adapter-node = one long-lived process). unref() keeps
// it from holding the process open in tests.
const sweeper = setInterval(() => {
	const now = Date.now();
	for (const [key, entry] of streams) {
		const ttl = entry.done ? DONE_TTL_MS : LIVE_TTL_MS;
		if (now - entry.touchedAt > ttl) {
			entry.abort.abort();
			clearTimeout(entry.timeout);
			streams.delete(key);
		}
	}
}, 60_000);
sweeper.unref?.();

/** Key separator - a character that can never appear in a username, shared by
 *  liveStreamKey and the per-user prefix match in beginRun. */
const SEP = ' ';

export function liveStreamKey(username: string, conversationId: string): string {
	return `${username}${SEP}${conversationId}`;
}

/**
 * Registers a new run for this conversation and returns the AbortSignal the
 * agent loop should honor. The signal fires on an explicit stop (DELETE), on
 * being superseded by a newer send in the SAME conversation, or at the hard
 * run timeout — NOT on client disconnect, and NOT on activity in other
 * conversations: switching to another chat and asking something there must
 * never kill a run still streaming here (the Claude backend handles
 * concurrent requests fine; the old one-run-per-user rule was a relic of
 * serialized local inference).
 */
export function beginRun(username: string, conversationId: string): AbortSignal {
	const key = liveStreamKey(username, conversationId);
	const previous = streams.get(key);
	if (previous) {
		previous.abort.abort();
		clearTimeout(previous.timeout);
		streams.delete(key);
	}
	const abort = new AbortController();
	const entry: LiveEntry = {
		chunks: [],
		done: false,
		touchedAt: Date.now(),
		abort,
		timeout: setTimeout(() => abort.abort(), RUN_TIMEOUT_MS),
		listeners: new Set()
	};
	streams.set(key, entry);
	return abort.signal;
}

function finish(entry: LiveEntry): void {
	entry.done = true;
	entry.touchedAt = Date.now();
	clearTimeout(entry.timeout);
	for (const listener of entry.listeners) listener(null);
	entry.listeners.clear();
}

/**
 * Tees the outgoing response through the buffer registered by beginRun. The
 * recorder branch pumps in the background, so the run keeps streaming into the
 * buffer even after the client branch is cancelled by a disconnect.
 */
export function recordStream(key: string, response: Response): Response {
	const entry = streams.get(key);
	const body = response.body;
	if (!entry || !body) return response;

	const [client, recorder] = body.tee();

	void (async () => {
		const reader = recorder.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				entry.chunks.push(value);
				entry.touchedAt = Date.now();
				for (const listener of entry.listeners) listener(value);
			}
		} catch {
			// Upstream aborted (stop/timeout) — fall through and close followers.
		} finally {
			finish(entry);
		}
	})();

	return new Response(client, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});
}

/**
 * Replay stream for a reconnecting client: everything buffered so far, then
 * the live tail until the run ends. Returns null when there is nothing to
 * resume (no entry — reply 204).
 */
export function replayStream(key: string): ReadableStream<Uint8Array> | null {
	const entry = streams.get(key);
	if (!entry) return null;
	entry.touchedAt = Date.now();

	let listener: ((chunk: Uint8Array | null) => void) | null = null;
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of entry.chunks) controller.enqueue(chunk);
			if (entry.done) {
				controller.close();
				return;
			}
			listener = (chunk) => {
				try {
					if (chunk === null) controller.close();
					else controller.enqueue(chunk);
				} catch {
					// Follower already gone — detach.
					if (listener) entry.listeners.delete(listener);
				}
			};
			entry.listeners.add(listener);
		},
		cancel() {
			if (listener) entry.listeners.delete(listener);
		}
	});
}

/** Whether a run — live or within its post-completion grace — is buffered. */
export function hasRun(key: string): boolean {
	return streams.has(key);
}

/** Explicit stop from the UI — aborts the agent run. */
export function stopRun(key: string): boolean {
	const entry = streams.get(key);
	if (!entry || entry.done) return false;
	entry.abort.abort();
	return true;
}

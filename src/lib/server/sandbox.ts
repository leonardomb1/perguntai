import { createHash, randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';

/**
 * BETA — code execution on microsandbox: hardware-isolated microVMs (libkrun/
 * KVM) booted per run from an OCI image, so model-generated Python is confined
 * behind a guest kernel, not just a container boundary.
 *
 * Two gates decide whether the feature is live:
 *  1. The admin toggle (access.json `capabilities.codeExecution`) — flipped in
 *     the console under Capacidades.
 *  2. This host actually running microVMs: /dev/kvm (or the MSB cloud backend
 *     via MSB_API_KEY). The SDK is imported LAZILY so deployments without KVM
 *     never load the native module at boot.
 *
 * Env (all optional):
 *  - MSB_IMAGE       OCI image for runs (default `microsandbox/python`).
 *  - MSB_MEMORY_MIB  guest memory (default 512).
 *  - MSB_CPUS        guest vCPUs (default 1).
 *  - MSB_TIMEOUT_MS  per-run wall clock (default 60000).
 *  - MSB_BACKEND / MSB_API_KEY — read by the SDK itself (local vs cloud).
 */

export interface SandboxRunResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
	durationMs: number;
}

const image = () => env.MSB_IMAGE || 'microsandbox/python';
/** Disk-backed home for run files (never /tmp: guest /tmp is a small tmpfs). */
const workdir = () => {
	const w = env.MSB_WORKDIR || '/home/perguntai';
	return /^\/[\w./-]+$/.test(w) ? w : '/home/perguntai';
};
const memoryMib = () => Number(env.MSB_MEMORY_MIB) || 512;
const cpus = () => Number(env.MSB_CPUS) || 1;
const timeoutMs = () => Number(env.MSB_TIMEOUT_MS) || 60_000;

const MAX_STREAM_CHARS = 24_000;
const clip = (s: string) =>
	s.length > MAX_STREAM_CHARS ? `${s.slice(0, MAX_STREAM_CHARS)}\n…[truncated]` : s;

/** Lazy SDK load — the napi module only touches the host when actually used. */
async function sdk() {
	return await import('microsandbox');
}

/**
 * Run a Python script in a fresh ephemeral microVM. `data` (when present) is
 * written to <workdir>/data.json and preloaded into a `data` variable (list
 * of dicts) before the user code runs — the model never pastes rows into
 * code. The workdir (default /home/perguntai) is created root-side and
 * chowned to the guest user, so any OCI image works.
 */
export async function runSandboxedPython(
	code: string,
	data?: unknown[],
	/** With a conversation, the run happens in its PERSISTENT workspace, so
	 *  main.py and any files it writes stay editable across turns. */
	conversation?: { username: string; conversationId: string }
): Promise<SandboxRunResult> {
	const started = Date.now();

	const runIn = async (
		sandbox: Awaited<ReturnType<typeof getConversationSandbox>>['sandbox'],
		w: string
	): Promise<SandboxRunResult> => {
		const fs = sandbox.fs();
		if (data) await fs.write(`${w}/data.json`, JSON.stringify(data));
		// The prelude keeps the old runPython contract feel: `data` is ready.
		const prelude = data
			? `import json\nwith open("${w}/data.json") as _f:\n    data = json.load(_f)\n`
			: 'data = None\n';
		await fs.write(`${w}/main.py`, prelude + code);

		const out = await sandbox.execWith('python', (b) =>
			b.arg(`${w}/main.py`).cwd(w).timeout(timeoutMs())
		);
		return {
			ok: out.success,
			stdout: clip(out.stdout()),
			stderr: clip(out.stderr()),
			exitCode: out.code,
			durationMs: Date.now() - started
		};
	};

	if (conversation?.conversationId) {
		const { sandbox, workdir: w } = await getConversationSandbox(
			conversation.username,
			conversation.conversationId
		);
		return runIn(sandbox, w);
	}

	// No conversation (warm-up, Testar, stateless /v1): one-shot ephemeral VM.
	const { Sandbox } = await sdk();
	const name = `pai-${randomUUID().slice(0, 8)}`;
	const sandbox = await Sandbox.builder(name)
		.image(image())
		.cpus(cpus())
		.memory(memoryMib())
		.ephemeral(true)
		.create();
	try {
		const w = await ensureWorkdir(sandbox);
		return await runIn(sandbox, w);
	} finally {
		await sandbox[Symbol.asyncDispose]().catch(() => {});
		await Sandbox.remove(name).catch(() => {});
	}
}

/**
 * Fire-and-forget warm-up: pulls the OCI image (the one slow step, ~70s on a
 * fresh cache volume) and boots one throwaway VM so the FIRST user run is a
 * ~300ms warm boot instead of a cold pull. Triggered on server start (when the
 * capability is already on) and when an admin toggles it on; the console's
 * Testar button doubles as a manual warm-up. Concurrent calls coalesce.
 */
let warming: Promise<void> | null = null;
export function warmSandbox(delayMs = 0): void {
	if (warming) return;
	warming = (async () => {
		// Deferred past server init: invoking the napi runtime during module
		// init has been seen to hang; a request-time call never does. The race
		// keeps the coalescing guard from wedging if a run stalls anyway.
		if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
		const started = Date.now();
		try {
			const result = await Promise.race([
				runSandboxedPython('print("warm")'),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('warm-up timed out after 10 min')), 600_000)
				)
			]);
			console.log(
				`sandbox warm-up ${result.ok ? 'ok' : 'FAILED'} in ${Date.now() - started}ms` +
					(result.ok ? '' : ` — ${(result.stderr || result.stdout).slice(0, 200)}`)
			);
		} catch (error) {
			console.warn('sandbox warm-up failed:', error instanceof Error ? error.message : error);
		} finally {
			warming = null;
		}
	})();
}

/** Health probe for the console's Testar button: boot, compute, tear down. */
export async function testSandbox(): Promise<
	{ ok: true; latencyMs: number; backend: string } | { ok: false; error: string }
> {
	try {
		const { defaultBackendInfo } = await sdk();
		const result = await runSandboxedPython('print(21 * 2)');
		if (!result.ok || !result.stdout.includes('42')) {
			return {
				ok: false,
				error: (result.stderr || result.stdout || `exit ${result.exitCode}`).slice(0, 300)
			};
		}
		return { ok: true, latencyMs: result.durationMs, backend: defaultBackendInfo().kind };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message.slice(0, 300) };
	}
}

// --- persistent per-conversation workspaces -------------------------------
//
// The file tools (sandboxReadFile/WriteFile/EditFile/Exec) and conversation
// runPython calls share ONE named, non-ephemeral microVM per conversation:
// files persist across tool calls and turns, so the model edits documents
// and scripts with DELTAS (sandboxEditFile) instead of re-emitting full
// content every time. `stop()` is documented to flush state to disk, so a
// stopped workspace resumes with its files intact (~300ms warm boot).
//
// Lifecycle: created lazily on first use; stopped after IDLE_STOP_MS of
// inactivity (files kept); removed when the conversation is deleted.

interface ConvEntry {
	sandbox: Awaited<ReturnType<(typeof import('microsandbox'))['Sandbox']['start']>>;
	workdir: string;
	lastUsed: number;
}

const IDLE_STOP_MS = 20 * 60_000;
const convSandboxes = new Map<string, ConvEntry>();
const convCreating = new Map<string, Promise<ConvEntry>>();

function convName(username: string, conversationId: string): string {
	const h = createHash('sha256').update(`${username}:${conversationId}`).digest('hex');
	return `pai-c-${h.slice(0, 24)}`;
}

async function ensureWorkdir(sandbox: ConvEntry['sandbox']): Promise<string> {
	const w = workdir();
	const uidOut = await sandbox.exec('id', ['-u']);
	const guestUid = uidOut.stdout().trim() || '1000';
	await sandbox.execWith('sh', (b) =>
		b.arg('-c').arg(`mkdir -p ${w} && chown ${guestUid} ${w}`).user('root')
	);
	return w;
}

/** The conversation's workspace VM: resume it, connect to it, or create it. */
export async function getConversationSandbox(
	username: string,
	conversationId: string
): Promise<{ sandbox: ConvEntry['sandbox']; workdir: string }> {
	const name = convName(username, conversationId);
	const cached = convSandboxes.get(name);
	if (cached) {
		cached.lastUsed = Date.now();
		return cached;
	}
	const pending = convCreating.get(name);
	if (pending) return pending;

	const creating = (async (): Promise<ConvEntry> => {
		const { Sandbox } = await sdk();
		let sandbox: ConvEntry['sandbox'];
		try {
			// Resumes a stopped workspace with its files intact.
			sandbox = await Sandbox.start(name);
		} catch {
			try {
				// Already running (e.g. from before an app restart) — reattach.
				sandbox = await (await Sandbox.get(name)).connect();
			} catch {
				sandbox = await Sandbox.builder(name)
					.image(image())
					.cpus(cpus())
					.memory(memoryMib())
					.ephemeral(false)
					.create();
			}
		}
		const w = await ensureWorkdir(sandbox);
		const entry: ConvEntry = { sandbox, workdir: w, lastUsed: Date.now() };
		convSandboxes.set(name, entry);
		return entry;
	})();
	convCreating.set(name, creating);
	try {
		return await creating;
	} finally {
		convCreating.delete(name);
	}
}

/** Called from the conversation-delete cascade: the workspace dies with it. */
export async function removeConversationSandbox(
	username: string,
	conversationId: string
): Promise<void> {
	const name = convName(username, conversationId);
	convSandboxes.delete(name);
	try {
		const { Sandbox } = await sdk();
		await (await Sandbox.get(name)).stop().catch(() => {});
		await Sandbox.remove(name);
	} catch {
		// Never created, or already gone — nothing to clean.
	}
}

// Idle reaper: stop (not remove) workspaces nobody touched for a while.
// Files persist; the next tool call resumes in ~300ms.
setInterval(() => {
	const now = Date.now();
	for (const [name, entry] of convSandboxes) {
		if (now - entry.lastUsed < IDLE_STOP_MS) continue;
		convSandboxes.delete(name);
		void (async () => {
			const { Sandbox } = await sdk();
			await (await Sandbox.get(name)).stop();
		})().catch(() => {});
	}
}, 60_000).unref();

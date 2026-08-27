import { randomUUID } from 'node:crypto';
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
 * written to /work/data.json and preloaded into a `data` variable (list of
 * dicts) before the user code runs — the model never pastes rows into code.
 */
export async function runSandboxedPython(
	code: string,
	data?: unknown[]
): Promise<SandboxRunResult> {
	const { Sandbox } = await sdk();
	const started = Date.now();
	const name = `pai-${randomUUID().slice(0, 8)}`;

	const sandbox = await Sandbox.builder(name)
		.image(image())
		.cpus(cpus())
		.memory(memoryMib())
		.ephemeral(true)
		.create();
	try {
		// Image-agnostic: the stock python image has no /work, and microsandbox
		// rejects a builder-level workdir that is missing from the guest.
		await sandbox.exec('mkdir', ['-p', '/work']);
		const fs = sandbox.fs();
		if (data) await fs.write('/work/data.json', JSON.stringify(data));
		// The prelude keeps the old runPython contract feel: `data` is ready.
		const prelude = data
			? 'import json\nwith open("/work/data.json") as _f:\n    data = json.load(_f)\n'
			: 'data = None\n';
		await fs.write('/work/main.py', prelude + code);

		const out = await sandbox.execWith('python', (b) =>
			b.arg('/work/main.py').cwd('/work').timeout(timeoutMs())
		);
		return {
			ok: out.success,
			stdout: clip(out.stdout()),
			stderr: clip(out.stderr()),
			exitCode: out.code,
			durationMs: Date.now() - started
		};
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
export function warmSandbox(): void {
	if (warming) return;
	warming = (async () => {
		const started = Date.now();
		try {
			const result = await runSandboxedPython('print("warm")');
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

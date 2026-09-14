import { createHash, randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import type { NetworkPolicy, Rule, Destination } from 'microsandbox';
import { parseEgressRule } from '$lib/egress';

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
 * Network: every VM boots under an explicit deny-by-default policy compiled
 * from the user's effective egress allow-list (access.ts resolveSandboxEgress).
 * Loopback, link-local/metadata and the host itself are pinned as leading deny
 * rules; DNS is opened only when at least one destination is allowed.
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

// --- network policy -----------------------------------------------------------

const rule = (action: 'allow' | 'deny', destination: Destination, ports: Rule['ports'] = []): Rule => ({
	direction: 'egress',
	destination,
	protocols: [],
	ports,
	action
});
const group = (g: 'host' | 'loopback' | 'link-local' | 'metadata' | 'multicast'): Destination => ({
	kind: 'group',
	group: g
});

/**
 * Compile an allow-list (canonical strings from $lib/egress) into the SDK's
 * first-match-wins policy. Order matters: DNS to the gateway first (it lives
 * in the "host" group), then the pinned denies, then the grants. An empty
 * list yields a fully closed VM — the same posture as before this feature.
 */
export function compileEgressPolicy(rules: string[]): NetworkPolicy {
	const grants: Rule[] = [];
	for (const text of rules) {
		const r = parseEgressRule(text);
		if (!r) continue;
		const dest: Destination =
			r.kind === 'cidr'
				? { kind: 'cidr', cidr: r.value }
				: r.kind === 'suffix'
					? { kind: 'domainSuffix', suffix: r.value.slice(2) }
					: { kind: 'domain', domain: r.value };
		grants.push(rule('allow', dest, r.ports));
	}
	return {
		defaultEgress: 'deny',
		// Matches the SDK's own canonical profiles; nothing is published, so
		// only the gateway can ever initiate toward the guest.
		defaultIngress: 'allow',
		rules: [
			...(grants.length ? [dnsRule()] : []),
			rule('deny', group('host')),
			rule('deny', group('metadata')),
			rule('deny', group('loopback')),
			rule('deny', group('link-local')),
			rule('deny', group('multicast')),
			...grants
		]
	};
}

/** Plain DNS (udp+tcp/53) to the in-process forwarder on the gateway. */
function dnsRule(): Rule {
	return {
		direction: 'egress',
		destination: group('host'),
		protocols: ['udp', 'tcp'],
		ports: [{ start: 53, end: 53 }],
		action: 'allow'
	};
}

/** Stable fingerprint of an allow-list — workspace VMs are keyed on it. */
export function egressHash(rules: string[]): string {
	return createHash('sha256').update(JSON.stringify([...rules].sort())).digest('hex').slice(0, 16);
}

/** VM labels: how the console attributes each VM without parsing names. */
const LABEL_APP = 'perguntai';
function labelsFor(
	kind: 'conversation' | 'ephemeral',
	egress: string[],
	owner?: { username: string; conversationId: string }
): Record<string, string> {
	return {
		app: LABEL_APP,
		kind,
		egress: egressHash(egress),
		...(owner ? { user: owner.username.toLowerCase(), conversation: owner.conversationId } : {})
	};
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
	conversation?: { username: string; conversationId: string },
	/** Effective egress allow-list (access.ts resolveSandboxEgress); default closed. */
	egress: string[] = []
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
			conversation.conversationId,
			egress
		);
		return runIn(sandbox, w);
	}

	// No conversation (warm-up, Testar, stateless /v1): one-shot ephemeral VM.
	const { Sandbox } = await sdk();
	const name = `pai-${randomUUID().slice(0, 8)}`;
	const policy = compileEgressPolicy(egress);
	const sandbox = await Sandbox.builder(name)
		.image(image())
		.cpus(cpus())
		.memory(memoryMib())
		.labels(labelsFor('ephemeral', egress))
		.network((n) => n.policy(policy))
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
	/** egressHash the VM was created with — a changed grant recreates it. */
	egress: string;
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

/** Labels stored in a VM's config (the SDK keeps config as untyped JSON). */
function configLabels(configJson: string): Record<string, string> {
	try {
		const labels = JSON.parse(configJson)?.labels;
		return typeof labels === 'object' && labels ? labels : {};
	} catch {
		return {};
	}
}

/**
 * The conversation's workspace VM: resume it, connect to it, or create it.
 * The network policy is fixed at creation, so when the user's effective
 * allow-list differs from the one the VM carries (label `egress`), the
 * workspace is rebuilt: files are tarred out, the VM replaced, files restored.
 */
export async function getConversationSandbox(
	username: string,
	conversationId: string,
	egress: string[] = []
): Promise<{ sandbox: ConvEntry['sandbox']; workdir: string }> {
	const name = convName(username, conversationId);
	const wanted = egressHash(egress);
	const cached = convSandboxes.get(name);
	if (cached && cached.egress === wanted) {
		cached.lastUsed = Date.now();
		return cached;
	}
	const pending = convCreating.get(name);
	if (pending) return pending;

	const creating = (async (): Promise<ConvEntry> => {
		const { Sandbox } = await sdk();
		const policy = compileEgressPolicy(egress);
		const create = () =>
			Sandbox.builder(name)
				.image(image())
				.cpus(cpus())
				.memory(memoryMib())
				.labels(labelsFor('conversation', egress, { username, conversationId }))
				.network((n) => n.policy(policy))
				.ephemeral(false)
				.create();

		let sandbox: ConvEntry['sandbox'];
		let existing: Awaited<ReturnType<typeof Sandbox.get>> | null = null;
		try {
			existing = await Sandbox.get(name);
		} catch {
			existing = null; // never created
		}

		if (!existing) {
			sandbox = await create();
		} else if (configLabels(existing.configJson).egress === wanted) {
			// Same policy: resume a stopped workspace (files intact) or reattach
			// to one still running from before an app restart.
			sandbox = cached?.sandbox ?? (await resumeOrConnect(existing));
		} else {
			// Policy changed (grant edited, or a VM from before this feature):
			// carry the workspace files across to a VM built under the new policy.
			const old = cached?.sandbox ?? (await resumeOrConnect(existing));
			const archive = await exportWorkdir(old);
			await old[Symbol.asyncDispose]().catch(() => {});
			await (await Sandbox.get(name)).stop().catch(() => {});
			await Sandbox.remove(name);
			sandbox = await create();
			if (archive) await importWorkdir(sandbox, archive);
		}
		const w = await ensureWorkdir(sandbox);
		const entry: ConvEntry = { sandbox, workdir: w, lastUsed: Date.now(), egress: wanted };
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

async function resumeOrConnect(
	handle: Awaited<ReturnType<(typeof import('microsandbox'))['Sandbox']['get']>>
): Promise<ConvEntry['sandbox']> {
	try {
		return await handle.start();
	} catch {
		return await handle.connect();
	}
}

/** Tar the workspace (relative paths) into memory; null when there is nothing to keep. */
async function exportWorkdir(sandbox: ConvEntry['sandbox']): Promise<Uint8Array | null> {
	const w = workdir();
	const out = await sandbox.execWith('sh', (b) =>
		b.arg('-c').arg(`[ -d ${w} ] && cd ${w} && tar czf /tmp/pai-ws.tgz . && echo ok`).user('root')
	);
	if (!out.stdout().includes('ok')) return null;
	return await sandbox.fs().read('/tmp/pai-ws.tgz');
}

async function importWorkdir(sandbox: ConvEntry['sandbox'], archive: Uint8Array): Promise<void> {
	const w = await ensureWorkdir(sandbox);
	await sandbox.fs().write('/tmp/pai-ws.tgz', archive);
	await sandbox.execWith('sh', (b) =>
		b.arg('-c').arg(`cd ${w} && tar xzf /tmp/pai-ws.tgz && chown -R $(stat -c %u ${w}) ${w}; rm -f /tmp/pai-ws.tgz`).user('root')
	);
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

// --- console monitor (admin) ---------------------------------------------------

export interface SandboxSnapshot {
	name: string;
	status: 'running' | 'stopped' | 'crashed' | 'draining';
	kind: 'conversation' | 'ephemeral' | 'unknown';
	user: string | null;
	conversationId: string | null;
	cpus: number;
	memoryMib: number;
	image: string;
	createdAt: number | null;
	updatedAt: number | null;
	/** Present for running VMs when the runtime answered within the budget. */
	metrics: {
		cpuPercent: number;
		memoryBytes: number;
		memoryLimitBytes: number;
		diskReadBytes: number;
		diskWriteBytes: number;
		netRxBytes: number;
		netTxBytes: number;
		uptimeMs: number;
	} | null;
}

const METRICS_BUDGET_MS = 1500;

/**
 * Every VM this app owns (label `app`, or the legacy `pai-` name prefix),
 * with point-in-time metrics for the running ones. One hung VM never stalls
 * the page: metrics are gathered in parallel under a short budget.
 */
export async function listSandboxes(): Promise<{ backend: string; sandboxes: SandboxSnapshot[] }> {
	const { Sandbox, defaultBackendInfo } = await sdk();
	const handles: Awaited<ReturnType<typeof Sandbox.get>>[] = [];
	let cursor: string | undefined;
	do {
		// The SDK caps a page at 100; pages are walked by cursor.
		const page = await Sandbox.listWith((l) => (cursor ? l.cursor(cursor).limit(100) : l.limit(100)));
		handles.push(...page.sandboxes);
		cursor = page.nextCursor;
	} while (cursor && handles.length < 2000);

	const ours = handles.filter(
		(h) => configLabels(h.configJson).app === LABEL_APP || h.name.startsWith('pai-')
	);
	const sandboxes = await Promise.all(
		ours.map(async (h): Promise<SandboxSnapshot> => {
			let config: Record<string, unknown> = {};
			try {
				config = JSON.parse(h.configJson) ?? {};
			} catch {
				// leave defaults
			}
			const labels = configLabels(h.configJson);
			const kind =
				labels.kind === 'conversation' || labels.kind === 'ephemeral'
					? labels.kind
					: h.name.startsWith('pai-c-')
						? 'conversation'
						: h.name.startsWith('pai-')
							? 'ephemeral'
							: 'unknown';
			const imageRef = (config.image as { Oci?: { reference?: string } } | undefined)?.Oci?.reference;
			const resources = (config.resources ?? {}) as { cpus?: unknown; memory_mib?: unknown };
			let metrics: SandboxSnapshot['metrics'] = null;
			if (h.status === 'running') {
				try {
					const m = await Promise.race([
						h.metrics(),
						new Promise<null>((r) => setTimeout(() => r(null), METRICS_BUDGET_MS))
					]);
					if (m) {
						metrics = {
							cpuPercent: m.cpuPercent,
							memoryBytes: m.memoryBytes,
							memoryLimitBytes: m.memoryLimitBytes,
							diskReadBytes: m.diskReadBytes,
							diskWriteBytes: m.diskWriteBytes,
							netRxBytes: m.netRxBytes,
							netTxBytes: m.netTxBytes,
							uptimeMs: m.uptimeMs
						};
					}
				} catch {
					metrics = null;
				}
			}
			return {
				name: h.name,
				status: h.status,
				kind,
				user: labels.user ?? null,
				conversationId: labels.conversation ?? null,
				cpus: typeof resources.cpus === 'number' ? resources.cpus : cpus(),
				memoryMib: typeof resources.memory_mib === 'number' ? resources.memory_mib : memoryMib(),
				image: typeof imageRef === 'string' ? imageRef : image(),
				createdAt: h.createdAt ? h.createdAt.getTime() : null,
				updatedAt: h.updatedAt ? h.updatedAt.getTime() : null,
				metrics
			};
		})
	);
	sandboxes.sort((a, b) => {
		const rank = (s: SandboxSnapshot) => (s.status === 'running' ? 0 : s.status === 'draining' ? 1 : 2);
		return rank(a) - rank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
	});
	return { backend: defaultBackendInfo().kind, sandboxes };
}

/** Only VMs this app created may be acted on from the console. */
function assertOurs(name: string): void {
	if (!/^pai-[a-z0-9-]{1,64}$/.test(name)) throw new Error('not a PerguntAI sandbox');
}

/** Stop a VM (files kept; a workspace resumes on its next tool call). */
export async function stopSandboxByName(name: string): Promise<void> {
	assertOurs(name);
	const { Sandbox } = await sdk();
	const entry = convSandboxes.get(name);
	convSandboxes.delete(name);
	await entry?.sandbox[Symbol.asyncDispose]().catch(() => {});
	await (await Sandbox.get(name)).stop();
}

/** Stop and delete a VM and its disk. A workspace is recreated empty on next use. */
export async function removeSandboxByName(name: string): Promise<void> {
	assertOurs(name);
	const { Sandbox } = await sdk();
	const entry = convSandboxes.get(name);
	convSandboxes.delete(name);
	await entry?.sandbox[Symbol.asyncDispose]().catch(() => {});
	await (await Sandbox.get(name)).stop().catch(() => {});
	await Sandbox.remove(name);
}

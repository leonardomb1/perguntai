import { env } from '$env/dynamic/private';

/**
 * Ephemeral Python execution on Windmill workers via the preview-jobs API —
 * the agent writes a throwaway script per question (code-interpreter style),
 * no pre-created Windmill scripts needed. Windmill auto-installs pip
 * dependencies from the script's imports, so pandas/statsmodels/scikit-learn
 * work out of the box (first use of a new import set is slower while the
 * environment builds).
 *
 * Auth is PER USER: each user stores their own Windmill token in settings, so
 * jobs run under their Windmill account and permissions. The instance is
 * described by WINDMILL_BASE_URL + WINDMILL_WORKSPACE.
 */

interface WindmillConfig {
	base: string;
	workspace: string;
	token: string;
}

/** Instance location from env; null when Windmill isn't configured at all. */
export function windmillInstance(): { base: string; workspace: string } | null {
	const base = env.WINDMILL_BASE_URL?.replace(/\/+$/, '');
	const workspace = env.WINDMILL_WORKSPACE;
	if (!base || !workspace) return null;
	return { base, workspace };
}

/** The user-scoped MCP endpoint (token authenticates in the URL itself). */
export function windmillMcpUrl(token: string): string | null {
	const instance = windmillInstance();
	if (!instance) return null;
	return `${instance.base}/api/mcp/w/${instance.workspace}/mcp?token=${encodeURIComponent(token)}`;
}

function windmillConfig(token: string | null): WindmillConfig | null {
	const instance = windmillInstance();
	if (!instance || !token) return null;
	return { ...instance, token };
}

/**
 * Windmill scope rules make a single pasted token insufficient: the MCP
 * endpoint only accepts tokens carrying an explicit `mcp` scope, while scoped
 * tokens are exclusive (an mcp-scoped token can't run preview jobs and vice
 * versa). So when the user saves a token, dedicated tokens are minted FROM it
 * (the user can paste any plain token from Windmill → User settings → Tokens).
 * Mints one token from another; null on any failure.
 */
async function mintToken(
	base: string,
	from: string,
	label: string,
	scopes?: string[]
): Promise<string | null> {
	try {
		const res = await fetch(`${base}/api/users/tokens/create`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${from}` },
			body: JSON.stringify(scopes ? { label, scopes } : { label })
		});
		if (!res.ok) return null;
		const minted = (await res.text()).trim();
		// Windmill returns the bare token string; anything else means failure.
		return /^[A-Za-z0-9]{20,}$/.test(minted) ? minted : null;
	} catch {
		return null;
	}
}

/**
 * Mint BOTH per-user tokens from one paste: the scoped chat token (mcp:all +
 * jobs:run:scripts) and a full-access deployment token — flow/schedule/
 * variable creation is rejected for scoped tokens, so activation needs its
 * own. `deploy` is null when minting fails (e.g. the pasted token itself was
 * scoped); the flows page then asks the user to re-save a fresh token.
 */
export async function provisionUserTokens(
	pasted: string
): Promise<{ mcp: string; deploy: string | null }> {
	const instance = windmillInstance();
	if (!instance) return { mcp: pasted, deploy: null };
	const [mcp, deploy] = await Promise.all([
		mintToken(instance.base, pasted, 'perguntai', ['mcp:all', 'jobs:run:scripts']),
		mintToken(instance.base, pasted, 'perguntai-deploy')
	]);
	return { mcp: mcp ?? pasted, deploy };
}

const POLL_INTERVAL_MS = 1500;

export async function runEphemeralPython(
	code: string,
	args: Record<string, unknown>,
	userToken: string | null,
	timeoutMs = 120_000
): Promise<{ result?: unknown; error?: string; logs?: string }> {
	const config = windmillConfig(userToken);
	if (!config) {
		return {
			error: windmillInstance()
				? 'Python execution is unavailable: the user has not configured their Windmill token. Tell them to add it in Settings → Connectors (Windmill: User settings → Tokens).'
				: 'Ephemeral Python is not configured on this server (WINDMILL_BASE_URL / WINDMILL_WORKSPACE unset).'
		};
	}
	const { base, workspace, token } = config;
	const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

	const submit = await fetch(`${base}/api/w/${workspace}/jobs/run/preview`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ language: 'python3', content: code, args })
	});
	const jobId = (await submit.text()).trim();
	if (!submit.ok) {
		return { error: `Windmill rejected the job (${submit.status}): ${jobId.slice(0, 300)}` };
	}

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
		const poll = await fetch(
			`${base}/api/w/${workspace}/jobs_u/completed/get_result_maybe/${jobId}`,
			{ headers }
		);
		if (!poll.ok) continue;
		const body = (await poll.json()) as {
			completed: boolean;
			result?: unknown;
			success?: boolean;
		};
		if (!body.completed) continue;

		if (body.success === false) {
			// Failed jobs put the traceback in result.error; fetch logs as backup.
			const err = body.result as { error?: { message?: string; name?: string } } | undefined;
			const logs = await fetchLogs(config, jobId);
			return {
				error: err?.error?.message ?? 'Script failed',
				logs: logs?.slice(-2000)
			};
		}
		return { result: body.result };
	}

	// Timed out — cancel the job so it doesn't run forever on the workers.
	await fetch(`${base}/api/w/${workspace}/jobs_u/queue/cancel/${jobId}`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ reason: 'timeout' })
	}).catch(() => {});
	return { error: `Script did not finish within ${Math.round(timeoutMs / 1000)}s and was cancelled` };
}

async function fetchLogs(config: WindmillConfig, jobId: string): Promise<string | null> {
	try {
		const res = await fetch(
			`${config.base}/api/w/${config.workspace}/jobs_u/get/${jobId}`,
			{ headers: { Authorization: `Bearer ${config.token}` } }
		);
		if (!res.ok) return null;
		const job = (await res.json()) as { logs?: string };
		return job.logs ?? null;
	} catch {
		return null;
	}
}

// --- flow deployment client (used by /api/flows activate/deactivate/run) ---
// All functions take an explicit token: the caller passes the user's
// full-access DEPLOY token (settings.windmillDeployToken), so everything is
// created under — and runs as — the user's own Windmill identity.

async function wmFetch(
	config: WindmillConfig,
	path: string,
	init?: RequestInit
): Promise<Response> {
	return fetch(`${config.base}/api/w/${config.workspace}${path}`, {
		...init,
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${config.token}`,
			...init?.headers
		}
	});
}

function requireConfig(token: string | null): WindmillConfig {
	const config = windmillConfig(token);
	if (!config) {
		throw new Error(
			windmillInstance()
				? 'No Windmill deploy token — re-save your Windmill token in Settings.'
				: 'Windmill is not configured (WINDMILL_BASE_URL / WINDMILL_WORKSPACE unset).'
		);
	}
	return config;
}

/** The Windmill username behind a token — flow paths live under u/<username>/. */
export async function windmillWhoami(token: string): Promise<string> {
	const config = requireConfig(token);
	const res = await wmFetch(config, '/users/whoami');
	if (!res.ok) throw new Error(`Windmill whoami failed (${res.status})`);
	const body = (await res.json()) as { username?: string };
	if (!body.username) throw new Error('Windmill whoami returned no username');
	return body.username;
}

export interface WindmillFlowPayload {
	summary: string;
	description?: string;
	value: unknown;
	schema: unknown;
}

/** Update-else-create, so re-activation is idempotent. */
export async function upsertWindmillFlow(
	token: string,
	path: string,
	flow: WindmillFlowPayload
): Promise<void> {
	const config = requireConfig(token);
	const body = JSON.stringify({ path, ...flow });
	const update = await wmFetch(config, `/flows/update/${path}`, { method: 'POST', body });
	if (update.ok) return;
	if (update.status !== 404) {
		throw new Error(`Windmill flow update failed (${update.status}): ${(await update.text()).slice(0, 300)}`);
	}
	const create = await wmFetch(config, '/flows/create', { method: 'POST', body });
	if (!create.ok) {
		throw new Error(`Windmill flow create failed (${create.status}): ${(await create.text()).slice(0, 300)}`);
	}
}

export async function deleteWindmillFlow(token: string, path: string): Promise<void> {
	const config = requireConfig(token);
	await wmFetch(config, `/flows/delete/${path}`, { method: 'DELETE' }).catch(() => {});
}

export async function setWindmillVariable(
	token: string,
	path: string,
	value: string,
	isSecret: boolean
): Promise<void> {
	const config = requireConfig(token);
	const update = await wmFetch(config, `/variables/update/${path}`, {
		method: 'POST',
		body: JSON.stringify({ value })
	});
	if (update.ok) return;
	const create = await wmFetch(config, '/variables/create', {
		method: 'POST',
		body: JSON.stringify({
			path,
			value,
			is_secret: isSecret,
			description: 'Managed by PerguntAI flows — do not edit'
		})
	});
	if (!create.ok) {
		throw new Error(
			`Windmill variable create failed (${create.status}): ${(await create.text()).slice(0, 300)}`
		);
	}
}

export async function deleteWindmillVariable(token: string, path: string): Promise<void> {
	const config = requireConfig(token);
	await wmFetch(config, `/variables/delete/${path}`, { method: 'DELETE' }).catch(() => {});
}

export interface WindmillSchedulePayload {
	/** 6-field Windmill cron (seconds first). */
	schedule: string;
	timezone: string;
	script_path: string;
	enabled: boolean;
}

export async function upsertWindmillSchedule(
	token: string,
	path: string,
	payload: WindmillSchedulePayload
): Promise<void> {
	const config = requireConfig(token);
	const update = await wmFetch(config, `/schedules/update/${path}`, {
		method: 'POST',
		body: JSON.stringify({ schedule: payload.schedule, timezone: payload.timezone, args: {} })
	});
	if (update.ok) {
		const enable = await wmFetch(config, `/schedules/setenabled/${path}`, {
			method: 'POST',
			body: JSON.stringify({ enabled: payload.enabled })
		});
		if (!enable.ok) throw new Error(`Windmill schedule enable failed (${enable.status})`);
		return;
	}
	const create = await wmFetch(config, '/schedules/create', {
		method: 'POST',
		body: JSON.stringify({
			path,
			schedule: payload.schedule,
			timezone: payload.timezone,
			script_path: payload.script_path,
			is_flow: true,
			args: {},
			enabled: payload.enabled
		})
	});
	if (!create.ok) {
		throw new Error(
			`Windmill schedule create failed (${create.status}): ${(await create.text()).slice(0, 300)}`
		);
	}
}

export async function deleteWindmillSchedule(token: string, path: string): Promise<void> {
	const config = requireConfig(token);
	await wmFetch(config, `/schedules/delete/${path}`, { method: 'DELETE' }).catch(() => {});
}

/** Fire a deployed flow now; returns the job id. */
export async function runWindmillFlow(token: string, path: string): Promise<string> {
	const config = requireConfig(token);
	const res = await wmFetch(config, `/jobs/run/f/${path}`, { method: 'POST', body: '{}' });
	const text = (await res.text()).trim();
	if (!res.ok) throw new Error(`Windmill run failed (${res.status}): ${text.slice(0, 300)}`);
	return text;
}

export interface WindmillRun {
	id: string;
	state: 'running' | 'queued' | 'scheduled' | 'success' | 'failed';
	startedAt: string | null;
	scheduledFor: string | null;
	durationMs: number | null;
}

/**
 * Recent runs of one deployed flow (schedule ticks + manual runs alike).
 * job_kinds=flow keeps deploy-time `flowdependencies` jobs out of the list;
 * queued jobs split into "queued" (due, waiting for a worker) vs "scheduled"
 * (Windmill pre-creates the NEXT cron tick as a future-dated queued job).
 */
export async function listFlowRuns(
	token: string,
	path: string,
	limit = 20
): Promise<WindmillRun[]> {
	const config = requireConfig(token);
	const res = await wmFetch(
		config,
		`/jobs/list?script_path_exact=${encodeURIComponent(path)}&job_kinds=flow&per_page=${limit}`
	);
	if (!res.ok) throw new Error(`Windmill job list failed (${res.status})`);
	const jobs = (await res.json()) as Array<{
		id: string;
		type?: string;
		running?: boolean;
		success?: boolean;
		started_at?: string;
		scheduled_for?: string;
		duration_ms?: number;
	}>;
	return jobs.map((job) => {
		const queued = job.type === 'QueuedJob';
		const state: WindmillRun['state'] = !queued
			? job.success
				? 'success'
				: 'failed'
			: job.running
				? 'running'
				: job.scheduled_for && Date.parse(job.scheduled_for) > Date.now()
					? 'scheduled'
					: 'queued';
		return {
			id: job.id,
			state,
			startedAt: job.started_at ?? null,
			scheduledFor: job.scheduled_for ?? null,
			durationMs: typeof job.duration_ms === 'number' ? job.duration_ms : null
		};
	});
}

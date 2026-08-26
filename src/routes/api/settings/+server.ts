import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import { getPublicSettings, saveUserSettings, type SettingsPatch } from '$lib/server/settings';
import { logAudit, requestMeta } from '$lib/server/audit';
import { provisionUserTokens } from '$lib/server/windmill';
import { resolveRole } from '$lib/server/access';
import { webSearchAvailable } from '$lib/server/agent';
import type { RequestHandler } from './$types';

/**
 * Per-user settings. GET never returns the Windmill token — only whether one
 * is set. PUT is a partial update: omitted fields are untouched;
 * windmillToken null clears it, a non-empty string replaces it.
 */

export const GET: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	return json({
		...(await getPublicSettings(user.username)),
		role: await resolveRole(user.username, user.profile),
		isAdmin: user.isAdmin ?? false,
		isPlatformAdmin: user.isPlatformAdmin ?? false,
		// Lets the UI hide the web-search toggle where the provider workspace
		// doesn't support the server-side tool.
		webSearchAvailable: webSearchAvailable()
	});
};

export const PUT: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const patch: SettingsPatch = {};
	if (typeof body.fullName === 'string') patch.fullName = body.fullName;
	if (typeof body.displayName === 'string') patch.displayName = body.displayName;
	if (typeof body.systemPrompt === 'string') patch.systemPrompt = body.systemPrompt;
	if (body.windmillToken === null) {
		patch.windmillToken = null;
		patch.windmillDeployToken = null;
	} else if (typeof body.windmillToken === 'string' && body.windmillToken.trim()) {
		// Exchange whatever the user pasted for TWO minted tokens: a scoped one
		// (mcp + jobs:run) for chat tools, and a full-access one for deploying
		// flows/schedules/variables (scoped tokens can't create those).
		const minted = await provisionUserTokens(body.windmillToken.trim());
		patch.windmillToken = minted.mcp;
		patch.windmillDeployToken = minted.deploy;
	}
	// Stored as pasted: Tabula personal tokens are already scoped server-side.
	if (body.tabulaToken === null) patch.tabulaToken = null;
	else if (typeof body.tabulaToken === 'string' && body.tabulaToken.trim()) {
		patch.tabulaToken = body.tabulaToken.trim();
	}
	if (Array.isArray(body.mcpServers)) {
		// Server-side sanitation lives in saveUserSettings; this only shapes.
		patch.mcpServers = body.mcpServers
			.filter((x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null)
			.map((x: Record<string, unknown>) => ({
				id: typeof x.id === 'string' ? x.id : undefined,
				name: typeof x.name === 'string' ? x.name : '',
				url: typeof x.url === 'string' ? x.url : '',
				token: x.token === null ? null : typeof x.token === 'string' ? x.token : undefined,
				enabled: x.enabled !== false
			}));
	}
	if (typeof body.webSearch === 'boolean') patch.webSearch = body.webSearch;
	if (typeof body.memoryEnabled === 'boolean') patch.memoryEnabled = body.memoryEnabled;
	if (body.onboarded === true) patch.onboarded = true;

	const saved = await saveUserSettings(user.username, patch);
	// Connector governance: any change to MCP servers or connector tokens is
	// an auditable event — who is wiring what into their agent.
	if (
		patch.mcpServers !== undefined ||
		patch.windmillToken !== undefined ||
		patch.tabulaToken !== undefined
	) {
		logAudit({
			actor: user.username,
			via: 'session',
			...requestMeta(request),
			category: 'connectors',
			action: 'connectors.update',
			status: 'ok',
			detail: {
				...(patch.mcpServers !== undefined
					? { mcp: saved.mcpServers.map((sv) => ({ name: sv.name, url: sv.url, enabled: sv.enabled })) }
					: {}),
				...(patch.windmillToken !== undefined
					? { windmillToken: patch.windmillToken === null ? 'removed' : 'set' }
					: {}),
				...(patch.tabulaToken !== undefined
					? { tabulaToken: patch.tabulaToken === null ? 'removed' : 'set' }
					: {})
			}
		});
	}
	return json({
		...saved,
		role: await resolveRole(user.username, user.profile)
	});
};

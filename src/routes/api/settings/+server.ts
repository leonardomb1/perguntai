import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import { getPublicSettings, saveUserSettings, type SettingsPatch } from '$lib/server/settings';
import { logAudit, requestMeta } from '$lib/server/audit';
import { resolveRole } from '$lib/server/access';
import { webSearchAvailable } from '$lib/server/agent';
import type { RequestHandler } from './$types';

/**
 * Per-user settings. GET never returns MCP tokens — only whether one is set.
 * PUT is a partial update: omitted fields are untouched.
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
	// Connector governance: any change to the user's MCP servers is an
	// auditable event — who is wiring what into their agent.
	if (patch.mcpServers !== undefined) {
		logAudit({
			actor: user.username,
			via: 'session',
			...requestMeta(request),
			category: 'connectors',
			action: 'connectors.update',
			status: 'ok',
			detail: {
				mcp: saved.mcpServers.map((sv) => ({ name: sv.name, url: sv.url, enabled: sv.enabled }))
			}
		});
	}
	return json({
		...saved,
		role: await resolveRole(user.username, user.profile)
	});
};

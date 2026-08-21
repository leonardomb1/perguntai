import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { authenticateRequest } from '$lib/server/auth';
import { testMcpServer } from '$lib/server/mcp';
import { getUserSettings } from '$lib/server/settings';
import { windmillMcpUrl } from '$lib/server/windmill';
import type { RequestHandler } from './$types';

/**
 * Connection test for the connectors page. The caller may send an unsaved
 * url/token (testing before save); anything omitted falls back to what their
 * own settings already store. Only ever exercises the calling user's
 * credentials, and never returns them — just whether tools came back.
 */
export const POST: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	let body: { kind?: string; id?: string; url?: string; token?: string };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const settings = await getUserSettings(user.username);
	let url: string | null = null;
	let token: string | null = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : null;

	if (body.kind === 'windmill') {
		// The Windmill token IS the URL credential — a pasted one hasn't been
		// exchanged for a scoped token yet, so the test only covers the stored one.
		url = settings.windmillToken ? windmillMcpUrl(settings.windmillToken) : null;
		token = null;
		if (!url) return json({ ok: false, error: 'no token configured' });
	} else if (body.kind === 'tabula') {
		url = env.TABULA_MCP_URL?.replace(/\/+$/, '') ?? null;
		token ??= settings.tabulaToken;
		if (!url) return json({ ok: false, error: 'TABULA_MCP_URL is not configured' });
		if (!token) return json({ ok: false, error: 'no token configured' });
	} else {
		url = typeof body.url === 'string' && /^https?:\/\//.test(body.url.trim()) ? body.url.trim() : null;
		if (!url) return json({ ok: false, error: 'invalid URL' });
		if (!token && typeof body.id === 'string') {
			token = settings.mcpServers.find((sv) => sv.id === body.id)?.token ?? null;
		}
	}

	return json(await testMcpServer({ url, token }));
};

import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import { testMcpServer } from '$lib/server/mcp';
import { getUserSettings } from '$lib/server/settings';
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

	let body: { id?: string; url?: string; token?: string };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const url =
		typeof body.url === 'string' && /^https?:\/\//.test(body.url.trim()) ? body.url.trim() : null;
	if (!url) return json({ ok: false, error: 'invalid URL' });

	let token: string | null =
		typeof body.token === 'string' && body.token.trim() ? body.token.trim() : null;
	if (!token && typeof body.id === 'string') {
		const settings = await getUserSettings(user.username);
		token = settings.mcpServers.find((sv) => sv.id === body.id)?.token ?? null;
	}

	return json(await testMcpServer({ url, token }));
};

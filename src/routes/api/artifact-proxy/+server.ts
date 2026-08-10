import { error, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { authenticateRequest } from '$lib/server/auth';

/**
 * Streams a Tabula artifact through this origin so the browser can preview it:
 * Tabula sends X-Frame-Options DENY and no CORS headers, which blocks direct
 * iframing/fetching from here. Locked to the Tabula host's /api/artifact/ path
 * (the URL is already a signed capability), so this is not an open proxy.
 */
export const GET: RequestHandler = async ({ request, url }) => {
	const user = await authenticateRequest(request);
	if (!user) throw error(401, 'Unauthorized');

	const target = url.searchParams.get('url') ?? '';
	const base = env.TABULA_MCP_URL;
	if (!base) throw error(404, 'Tabula is not configured');

	let parsed: URL;
	try {
		parsed = new URL(target);
	} catch {
		throw error(400, 'Invalid url');
	}
	if (parsed.origin !== new URL(base).origin || !parsed.pathname.startsWith('/api/artifact/')) {
		throw error(403, 'Only Tabula artifact links can be proxied');
	}

	const upstream = await fetch(parsed).catch(() => null);
	if (!upstream || !upstream.ok) throw error(502, 'Artifact unavailable (it may have expired)');

	return new Response(upstream.body, {
		headers: {
			'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
			'cache-control': 'private, no-store'
		}
	});
};

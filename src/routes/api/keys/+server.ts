import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import { createKey, listKeys } from '$lib/server/apiKeys';
import type { RequestHandler } from './$types';

/**
 * Personal API keys. Only an interactive session may manage keys — a key
 * cannot mint another key, so a leaked one cannot extend its own life.
 */
async function requireSession(request: Request) {
	const header = request.headers.get('authorization') ?? '';
	if (header.startsWith('Bearer pai_')) return null;
	return authenticateRequest(request);
}

export const GET: RequestHandler = async ({ request }) => {
	const user = await requireSession(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	return json({ keys: await listKeys(user.username) });
};

export const POST: RequestHandler = async ({ request }) => {
	const user = await requireSession(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	let body: { label?: string; expiresInDays?: number } = {};
	try {
		body = await request.json();
	} catch {
		// label is optional; an empty body is fine
	}

	const days = Number(body.expiresInDays);
	const { key, record } = await createKey(
		user.username,
		body.label ?? '',
		Number.isFinite(days) && days > 0 ? days : undefined
	);

	// The plaintext is returned exactly once — only its hash is stored.
	return json({ key, record }, { status: 201 });
};

import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import { listMemories, saveMemory, removeMemory, clearMemories } from '$lib/server/memory';
import type { RequestHandler } from './$types';

/**
 * Personal memory management from Settings. Fully user-owned: the caller only
 * ever sees and edits their OWN memory (keyed on the authenticated username), so
 * there is no cross-user access to guard beyond authentication. Deletion is
 * unconditional (LGPD right to erasure).
 */

export const GET: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	return json({ memories: await listMemories(user.username) });
};

// Create a topic (no id) or update one (id given).
export const POST: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	const body = await request.json().catch(() => ({}));
	const result = await saveMemory(
		user.username,
		{
			id: typeof body.id === 'string' ? body.id : undefined,
			title: typeof body.title === 'string' ? body.title : '',
			summary: typeof body.summary === 'string' ? body.summary : '',
			details: typeof body.details === 'string' ? body.details : ''
		},
		'user'
	);
	if (!result.ok) return json({ error: result.reason }, { status: 400 });
	return json({ memory: result.memory });
};

export const DELETE: RequestHandler = async ({ request, url }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	if (url.searchParams.get('all') === '1') {
		await clearMemories(user.username);
		return json({ ok: true });
	}
	const id = url.searchParams.get('id');
	if (!id) return json({ error: 'id required' }, { status: 400 });
	const ok = await removeMemory(user.username, id);
	return json({ ok });
};

import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import { listSkills, removeSkill, saveSkill } from '$lib/server/skills';
import type { RequestHandler } from './$types';

/**
 * Personal learned skills from Settings (Habilidades). Same ownership model as
 * memory: the caller only ever sees and edits their OWN skills, so
 * authentication is the whole guard. Deletion is unconditional.
 */

export const GET: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	return json({ skills: await listSkills(user.username) });
};

// Create a skill (no id) or update one (id given).
export const POST: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	const body = await request.json().catch(() => ({}));
	const result = await saveSkill(
		user.username,
		{
			id: typeof body.id === 'string' ? body.id : undefined,
			name: typeof body.name === 'string' ? body.name : '',
			description: typeof body.description === 'string' ? body.description : '',
			content: typeof body.content === 'string' ? body.content : ''
		},
		'user'
	);
	if (!result.ok) return json({ error: result.reason }, { status: 400 });
	return json({ skill: result.skill });
};

export const DELETE: RequestHandler = async ({ request, url }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	const id = url.searchParams.get('id');
	if (!id) return json({ error: 'Missing id' }, { status: 400 });
	const removed = await removeSkill(user.username, id);
	return removed ? json({ ok: true }) : json({ error: 'Not found' }, { status: 404 });
};

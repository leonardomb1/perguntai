import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import {
	deleteConversation,
	isValidConversationId,
	listConversations,
	loadMessages,
	renameConversation,
	saveConversation
} from '$lib/server/conversations';
import type { RequestHandler } from './$types';

/** List all conversations, or fetch one's messages with ?id=. */
export const GET: RequestHandler = async ({ request, url }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	const id = url.searchParams.get('id');
	if (id) {
		if (!isValidConversationId(id)) return json({ error: 'Invalid id' }, { status: 400 });
		return json({ messages: await loadMessages(user.username, id) });
	}
	return json({ conversations: await listConversations(user.username) });
};

/** Upsert a conversation's messages (used by autosave and the migration). */
export const PUT: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	const { id, messages, title } = await request.json().catch(() => ({}));
	if (!isValidConversationId(id) || !Array.isArray(messages)) {
		return json({ error: 'Expected { id, messages[] }' }, { status: 400 });
	}
	await saveConversation(user.username, id, messages, typeof title === 'string' ? title : undefined);
	return json({ ok: true });
};

/** Rename. */
export const PATCH: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	const { id, title } = await request.json().catch(() => ({}));
	if (!isValidConversationId(id) || typeof title !== 'string') {
		return json({ error: 'Expected { id, title }' }, { status: 400 });
	}
	await renameConversation(user.username, id, title);
	return json({ ok: true });
};

/** Delete a conversation and cascade to its attached documents. */
export const DELETE: RequestHandler = async ({ request, url }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	const id = url.searchParams.get('id');
	if (!isValidConversationId(id)) return json({ error: 'Invalid id' }, { status: 400 });
	await deleteConversation(user.username, id);
	return json({ ok: true });
};

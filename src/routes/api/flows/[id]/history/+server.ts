import { json } from '@sveltejs/kit';
import { requireFlowAccess } from '$lib/server/guards';
import { loadFlowChat, saveFlowChat } from '$lib/server/flows';
import type { RequestHandler } from './$types';

/** Builder-chat transcript for one flow — stored next to the OWNER's record. */

export const GET: RequestHandler = async ({ request, params }) => {
	const ctx = await requireFlowAccess(request, params.id, 'view');
	if (ctx instanceof Response) return ctx;
	return json({ messages: await loadFlowChat(ctx.record.owner, params.id) });
};

export const PUT: RequestHandler = async ({ request, params }) => {
	const ctx = await requireFlowAccess(request, params.id, 'edit');
	if (ctx instanceof Response) return ctx;
	const body = await request.json().catch(() => ({}));
	await saveFlowChat(ctx.record.owner, params.id, Array.isArray(body.messages) ? body.messages : []);
	return json({ ok: true });
};

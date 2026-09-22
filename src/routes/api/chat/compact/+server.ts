import { json } from '@sveltejs/kit';
import type { UIMessage } from 'ai';
import { authenticateRequest } from '$lib/server/auth';
import { departmentsForUser, policiesForUser } from '$lib/server/access';
import { lastMeasuredContext, summarizeConversation, type CompactionMarker } from '$lib/server/compaction';
import { DEFAULT_MODEL } from '$lib/server/models';
import { addUsage, weightedTokens } from '$lib/server/usage';
import { logAudit, requestMeta } from '$lib/server/audit';
import { newId } from '$lib/id';
import type { RequestHandler } from './$types';

/**
 * Summarizes the conversation so far and returns the marker message the client
 * appends to its transcript. Runs on the deployment default model — every user
 * may use it, and it is the cheap one; the summary input is bounded anyway.
 */
export const POST: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	const body = await request.json().catch(() => ({}));
	const messages = Array.isArray(body.messages) ? (body.messages as UIMessage[]) : [];
	if (messages.length === 0) return json({ error: 'Nothing to compact' }, { status: 400 });

	let summary: string;
	let usage;
	try {
		({ summary, usage } = await summarizeConversation(messages, DEFAULT_MODEL));
	} catch (error) {
		console.error('compaction failed:', error);
		return json({ error: error instanceof Error ? error.message.slice(0, 300) : 'compaction failed' }, { status: 502 });
	}
	if (!summary) return json({ error: 'Empty summary' }, { status: 502 });

	const [depts, policies] = await Promise.all([departmentsForUser(user.profile), policiesForUser(user.profile)]);
	await addUsage(user.username, weightedTokens(usage), undefined, {
		depts: depts.map((d) => d.id),
		policies: policies.map((p) => p.id),
		viaApi: Boolean(user.apiKey)
	}).catch((e) => console.warn('usage tracking failed:', e));
	logAudit({
		actor: user.username,
		via: user.apiKey ? 'apikey' : 'session',
		...requestMeta(request),
		category: 'chat',
		action: 'chat.compact',
		target: DEFAULT_MODEL,
		status: 'ok',
		detail: { messages: messages.length, contextBefore: lastMeasuredContext(messages)?.tokens ?? null }
	});

	const compaction: CompactionMarker = {
		summary,
		at: Date.now(),
		model: DEFAULT_MODEL,
		contextBefore: lastMeasuredContext(messages)?.tokens
	};
	const marker: UIMessage = {
		id: newId(),
		role: 'assistant',
		metadata: { compaction },
		parts: [{ type: 'text', text: summary }]
	};
	return json({ message: marker });
};

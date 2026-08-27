import { json } from '@sveltejs/kit';
import { createAgentUIStreamResponse } from 'ai';
import { sanitizeToolInputs } from '$lib/server/agent';
import { buildEmbedAgent, resolveEmbedAccess } from '$lib/server/embed';
import { getCapabilities, getEffectiveOrgPrompt } from '$lib/server/access';
import { withHeartbeat } from '$lib/server/heartbeat';
import { addUsage, usageToday, weightedTokens } from '$lib/server/usage';
import { logAudit, requestMeta } from '$lib/server/audit';
import type { RequestHandler } from './$types';

/**
 * Anonymous embedded chat — NO authentication by design (see server/embed.ts
 * for the security model). Guards, in order: the admin capability toggle, the
 * service-account config, a per-IP sliding-window throttle, the per-
 * conversation message cap, and the shared daily token budget.
 */

/** 6 requests a minute per address — an embed visitor chats, a script floods. */
const attempts = new Map<string, number[]>();
function throttled(key: string, max = 6, windowMs = 60_000): boolean {
	const now = Date.now();
	const recent = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
	if (recent.length >= max) {
		attempts.set(key, recent);
		return true;
	}
	recent.push(now);
	attempts.set(key, recent);
	if (attempts.size > 10_000) {
		for (const [k, v] of attempts) if (v.every((t) => now - t >= windowMs)) attempts.delete(k);
	}
	return false;
}

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	if (!(await getCapabilities()).embedChat) {
		return json({ error: 'Embedded chat is not enabled' }, { status: 404 });
	}
	if (throttled(getClientAddress())) {
		return json({ error: 'Muitas mensagens — aguarde um minuto.', code: 'throttled' }, { status: 429 });
	}

	const body = await request.json().catch(() => null);
	// Per-portal embed key (emb_…) or the keyless env service account.
	const access = await resolveEmbedAccess(
		typeof body?.embedKey === 'string' ? body.embedKey : null
	);
	if (!access) {
		return json({ error: 'Invalid or missing embed access', code: 'key' }, { status: 401 });
	}
	const messages = body?.messages;
	if (!Array.isArray(messages) || messages.length === 0) {
		return json({ error: 'messages is required' }, { status: 400 });
	}
	// The n-messages-then-reset contract, enforced server-side: the client
	// counts too (for UX), but only this check actually bounds a hand-rolled
	// caller.
	const userTurns = messages.filter((mm) => (mm as { role?: string })?.role === 'user').length;
	if (userTurns > access.maxMessages) {
		return json(
			{ error: 'Limite de mensagens desta conversa atingido — reinicie a conversa.', code: 'limit' },
			{ status: 429 }
		);
	}
	sanitizeToolInputs(messages);

	// Daily budget — per key when a key is used, else the shared env surface.
	const used = await usageToday(access.usageUser);
	if (used >= access.dailyTokens) {
		logAudit({
			actor: access.usageUser,
			via: 'session',
			...requestMeta(request),
			category: 'chat',
			action: 'embed.chat',
			status: 'denied',
			detail: { reason: 'daily_budget' }
		});
		return json(
			{ error: 'O limite diário deste assistente foi atingido — tente amanhã.', code: 'budget' },
			{ status: 429 }
		);
	}

	let totalTokens = 0;
	const raw = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, steps: 0 };

	return withHeartbeat(
		await createAgentUIStreamResponse({
			agent: buildEmbedAgent(access, await getEffectiveOrgPrompt(), access.dailyTokens - used),
			uiMessages: messages,
			abortSignal: request.signal,
			onStepEnd: (event) => {
				totalTokens += weightedTokens(event.usage);
				const u = event.usage;
				raw.steps += 1;
				raw.input += u?.inputTokens ?? 0;
				raw.cacheRead += u?.inputTokenDetails?.cacheReadTokens ?? 0;
				raw.cacheWrite += u?.inputTokenDetails?.cacheWriteTokens ?? 0;
				raw.output += u?.outputTokens ?? 0;
			},
			onFinish: async () => {
				await addUsage(access.usageUser, totalTokens, {
					input: raw.input,
					cacheRead: raw.cacheRead,
					cacheWrite: raw.cacheWrite,
					output: raw.output
				}).catch((e) => console.warn('embed usage tracking failed:', e));
				logAudit({
					actor: access.usageUser,
					via: 'session',
					...requestMeta(request),
					category: 'chat',
					action: 'embed.chat',
					target: access.model,
					status: 'ok',
					detail: {
						tokens: Math.round(totalTokens),
						steps: raw.steps,
						...(access.keyLabel ? { key: access.keyLabel } : {})
					}
				});
			},
			onError: (error) => {
				console.error('embed chat stream error:', error);
				const message = error instanceof Error ? error.message : String(error);
				return message.slice(0, 300);
			}
		})
	);
};

/** Public config the embed page needs before the first message. */
export const GET: RequestHandler = async ({ url }) => {
	if (!(await getCapabilities()).embedChat) return json({ enabled: false });
	const access = await resolveEmbedAccess(url.searchParams.get('key'));
	if (!access) return json({ enabled: false });
	return json({ enabled: true, maxMessages: access.maxMessages });
};

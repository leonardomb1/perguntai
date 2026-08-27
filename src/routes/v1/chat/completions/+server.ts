import { json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { authenticateRequest } from '$lib/server/auth';
import { connectMcpTools } from '$lib/server/mcp';
import { buildAgent } from '$lib/server/agent';
import { getUserSettings } from '$lib/server/settings';
import {
	departmentsForUser,
	getEffectiveOrgPrompt,
	policiesForUser,
	resolveDailyLimit,
	resolveModel
} from '$lib/server/access';
import { addUsage, usageToday, weightedTokens } from '$lib/server/usage';
import { logAudit, requestMeta } from '$lib/server/audit';
import type { RequestHandler } from './$types';

/**
 * OpenAI-compatible `POST /v1/chat/completions` — the open-source lingua
 * franca. Any client that can talk to OpenAI/Ollama/vLLM (LangChain, LiteLLM,
 * Open WebUI, plain `openai` SDKs) can point its base_url here with a `pai_`
 * key and get the FULL agent: warehouse queries, documents, Python — running
 * under the caller's own permissions, limits and audit trail.
 *
 * Stateless by design (no conversation store) — callers keep their own
 * history and send it back, exactly as with any OpenAI-style API.
 */

const oaiError = (status: number, message: string, type = 'invalid_request_error') =>
	json({ error: { message, type } }, { status });

interface OaiMessage {
	role: 'system' | 'user' | 'assistant';
	content: unknown;
}

/** OpenAI content is a string or an array of typed parts — keep the text. */
function contentText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text) : ''))
			.join('');
	}
	return '';
}

export const POST: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return oaiError(401, 'Invalid API key', 'authentication_error');

	const body = await request.json().catch(() => null);
	if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
		return oaiError(400, "'messages' is required and must be a non-empty array");
	}
	const messages = (body.messages as OaiMessage[])
		.filter((mm) => mm && ['system', 'user', 'assistant'].includes(mm.role))
		.map((mm) => ({ role: mm.role, content: contentText(mm.content) }));
	if (messages.length === 0) return oaiError(400, 'no usable messages');

	// Daily limit — same policy-aware resolution as the app's chat endpoint.
	const dailyLimit = await resolveDailyLimit(user.username, user.profile);
	let tokenBudget: number | null = null;
	if (dailyLimit) {
		const used = await usageToday(user.username);
		if (used >= dailyLimit) return oaiError(429, 'Daily token limit reached', 'rate_limit_error');
		tokenBudget = dailyLimit - used;
	}

	const model = await resolveModel(
		user.username,
		typeof body.model === 'string' ? body.model : '',
		user.profile
	);
	const settings = await getUserSettings(user.username);
	const mcp = await connectMcpTools(settings.mcpServers.filter((sv) => sv.enabled));

	const agent = await buildAgent(
		user,
		settings,
		mcp.tools,
		'', // stateless — no conversation, so no attached documents
		await getEffectiveOrgPrompt(user.profile),
		tokenBudget,
		model,
		'api'
	);

	const id = `chatcmpl-${randomUUID()}`;
	const created = Math.floor(Date.now() / 1000);
	let totalTokens = 0;
	const raw = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, steps: 0 };

	const account = async () => {
		const [depts, policies] = await Promise.all([
			departmentsForUser(user.profile),
			policiesForUser(user.profile)
		]);
		await addUsage(
			user.username,
			totalTokens,
			{ input: raw.input, cacheRead: raw.cacheRead, cacheWrite: raw.cacheWrite, output: raw.output },
			{
				depts: depts.map((d) => d.id),
				policies: policies.map((p) => p.id),
				viaApi: Boolean(user.apiKey)
			}
		).catch((e) => console.warn('usage tracking failed:', e));
		logAudit({
			actor: user.username,
			via: user.apiKey ? 'apikey' : 'session',
			...(user.apiKey ? { keyId: user.apiKey.id, keyLabel: user.apiKey.label } : {}),
			...requestMeta(request),
			category: 'chat',
			action: 'v1.completions',
			target: model,
			status: 'ok',
			detail: { tokens: Math.round(totalTokens), steps: raw.steps, stream: body.stream === true }
		});
	};

	const onStepFinish = (step: { usage?: Parameters<typeof weightedTokens>[0] }) => {
		totalTokens += weightedTokens(step.usage);
		const u = step.usage as
			| { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } }
			| undefined;
		raw.steps += 1;
		raw.input += u?.inputTokens ?? 0;
		raw.cacheRead += u?.inputTokenDetails?.cacheReadTokens ?? 0;
		raw.cacheWrite += u?.inputTokenDetails?.cacheWriteTokens ?? 0;
		raw.output += u?.outputTokens ?? 0;
	};

	const oaiUsage = () => ({
		prompt_tokens: raw.input,
		completion_tokens: raw.output,
		total_tokens: raw.input + raw.output
	});

	if (body.stream === true) {
		const result = agent.stream({ messages, onStepFinish });
		const encoder = new TextEncoder();
		const sse = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
		const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
			id,
			object: 'chat.completion.chunk',
			created,
			model,
			choices: [{ index: 0, delta, finish_reason: finish }]
		});

		const stream = new ReadableStream({
			async start(controller) {
				try {
					controller.enqueue(sse(chunk({ role: 'assistant' })));
					for await (const text of (await result).textStream) {
						if (text) controller.enqueue(sse(chunk({ content: text })));
					}
					controller.enqueue(sse({ ...chunk({}, 'stop'), usage: oaiUsage() }));
					controller.enqueue(encoder.encode('data: [DONE]\n\n'));
				} catch (error) {
					console.error('v1 stream error:', error);
					const message = error instanceof Error ? error.message : String(error);
					controller.enqueue(sse({ error: { message: message.slice(0, 300), type: 'server_error' } }));
				} finally {
					await mcp.close().catch(() => {});
					await account();
					controller.close();
				}
			}
		});
		return new Response(stream, {
			headers: {
				'content-type': 'text/event-stream; charset=utf-8',
				'cache-control': 'no-store',
				connection: 'keep-alive'
			}
		});
	}

	try {
		const result = await agent.generate({ messages, onStepFinish });
		return json({
			id,
			object: 'chat.completion',
			created,
			model,
			choices: [
				{
					index: 0,
					message: { role: 'assistant', content: result.text },
					finish_reason: 'stop'
				}
			],
			usage: oaiUsage()
		});
	} catch (error) {
		console.error('v1 completion error:', error);
		const message = error instanceof Error ? error.message : String(error);
		return oaiError(500, message.slice(0, 300), 'server_error');
	} finally {
		await mcp.close().catch(() => {});
		await account();
	}
};

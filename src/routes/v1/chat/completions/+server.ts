import { json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { jsonSchema, tool, type ModelMessage, type ToolSet } from 'ai';
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
 * Open WebUI, OpenCode, plain `openai` SDKs) can point its base_url here with
 * a `pai_` key and get the FULL agent: warehouse queries, documents, Python —
 * running under the caller's own permissions, limits and audit trail.
 *
 * CLIENT TOOLS coexist with the server's: `tools` in the request are merged
 * into the agent's toolset WITHOUT an execute — when the model picks one, the
 * loop pauses and the call is returned OpenAI-style (`finish_reason:
 * "tool_calls"`); the caller runs it locally (bash, edit, …) and sends the
 * `tool`-role result back on the next request. Server tools (warehouse,
 * documents, sandbox) keep executing inside the loop, invisible to the caller
 * beyond their effect on the answer.
 *
 * Stateless by design (no conversation store) — callers keep their own
 * history and send it back, exactly as with any OpenAI-style API.
 */

const oaiError = (status: number, message: string, type = 'invalid_request_error') =>
	json({ error: { message, type } }, { status });

interface OaiToolCall {
	id?: string;
	function?: { name?: string; arguments?: string };
}
interface OaiMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: unknown;
	tool_calls?: OaiToolCall[];
	tool_call_id?: string;
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

const parseArgs = (raw: string | undefined): Record<string, unknown> => {
	try {
		const parsed = JSON.parse(raw || '{}');
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
};

export const POST: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return oaiError(401, 'Invalid API key', 'authentication_error');

	const body = await request.json().catch(() => null);
	if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
		return oaiError(400, "'messages' is required and must be a non-empty array");
	}

	// --- caller-defined tools (executed CLIENT-side) ---
	const clientTools: ToolSet = {};
	const clientToolNames = new Set<string>();
	if (body.tool_choice !== 'none' && Array.isArray(body.tools)) {
		for (const t of body.tools as {
			type?: string;
			function?: { name?: string; description?: string; parameters?: unknown };
		}[]) {
			const name = t?.type === 'function' ? t.function?.name : undefined;
			if (!name || clientToolNames.size >= 64) continue;
			clientToolNames.add(name);
			// No `execute`: the loop pauses on these and the call surfaces to the
			// caller as an OpenAI tool_calls response.
			clientTools[name] = tool({
				description: `[caller-side tool — executes on the API caller's machine, NOT in your environment] ${t.function?.description ?? ''}`,
				inputSchema: jsonSchema(
					(t.function?.parameters as Record<string, unknown>) ?? { type: 'object', properties: {} }
				)
			});
		}
	}

	// Caller system messages ride as bracketed user turns: the agent forbids
	// system-role entries in `messages` (its own instructions occupy the system
	// block), and appending per-request text to the real system prompt would
	// bust the cached prefix on every call.
	const instructionTurn = (content: string): ModelMessage => ({
		role: 'user',
		content: `[System instruction from the API caller]\n${content}`
	});

	// Convert the OpenAI history, INCLUDING the client-tool round trip: an
	// assistant message's tool_calls become tool-call parts, and tool-role
	// messages become tool results (toolName recovered from the paired call —
	// OpenAI tool messages only carry the id).
	const idToName = new Map<string, string>();
	const messages: ModelMessage[] = [];
	for (const mm of body.messages as OaiMessage[]) {
		if (!mm || typeof mm !== 'object') continue;
		if (mm.role === 'system') {
			messages.push(instructionTurn(contentText(mm.content)));
		} else if (mm.role === 'user') {
			messages.push({ role: 'user', content: contentText(mm.content) });
		} else if (mm.role === 'assistant') {
			const text = contentText(mm.content);
			const calls = Array.isArray(mm.tool_calls) ? mm.tool_calls : [];
			if (calls.length) {
				const parts: Exclude<ModelMessage & { role: 'assistant' }, string>['content'] = [
					...(text ? [{ type: 'text' as const, text }] : []),
					...calls.flatMap((c) => {
						const name = c.function?.name;
						const callId = c.id || randomUUID();
						if (!name) return [];
						idToName.set(callId, name);
						return [
							{
								type: 'tool-call' as const,
								toolCallId: callId,
								toolName: name,
								input: parseArgs(c.function?.arguments)
							}
						];
					})
				];
				if (parts.length) messages.push({ role: 'assistant', content: parts });
			} else if (text) {
				messages.push({ role: 'assistant', content: text });
			}
		} else if (mm.role === 'tool' && typeof mm.tool_call_id === 'string') {
			messages.push({
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: mm.tool_call_id,
						toolName: idToName.get(mm.tool_call_id) ?? 'tool',
						output: { type: 'text', value: contentText(mm.content) }
					}
				]
			});
		}
	}
	if (messages.length === 0) return oaiError(400, 'no usable messages');

	if (clientToolNames.size > 0) {
		// Without this the model conflates caller tools with its own sandbox and
		// refuses ("não tenho acesso à sua máquina") instead of calling them.
		messages.push(
			instructionTurn(
				`The caller registered ${clientToolNames.size} CALLER-SIDE tool(s) — ${[...clientToolNames].join(', ')} — which execute on the CALLER'S OWN machine/environment, not in your sandbox. When the request calls for one, invoke it directly; the caller runs it and returns the result in the next message. Never claim you lack access to the caller's machine while these tools are available.`
			)
		);
	}

	// OpenAI `response_format`: json_object and json_schema. Claude has no
	// native JSON mode, so this rides as a hard trailing instruction — the
	// full agent (tools included) still runs, only the final message is
	// constrained. Fenced output is unwrapped server-side for non-streaming.
	const rf = body.response_format as
		| { type?: string; json_schema?: { name?: string; schema?: unknown } }
		| undefined;
	let jsonMode = false;
	if (rf && typeof rf === 'object' && rf.type && rf.type !== 'text') {
		if (rf.type === 'json_object') {
			jsonMode = true;
			messages.push(
				instructionTurn(
					'Your entire final message MUST be a single valid JSON value — no markdown fences, no prose before or after it.'
				)
			);
		} else if (rf.type === 'json_schema') {
			const schema = rf.json_schema?.schema;
			if (!schema) return oaiError(400, "'response_format.json_schema.schema' is required");
			jsonMode = true;
			messages.push(
				instructionTurn(
					'Your entire final message MUST be a single JSON document that validates against this ' +
						`JSON Schema — no markdown fences, no prose before or after it:\n${JSON.stringify(schema)}`
				)
			);
		} else {
			return oaiError(400, `unsupported response_format.type '${rf.type}'`);
		}
	}

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
		// Client tools merge alongside the user's MCP tools (spread last in the
		// agent, so a name collision resolves in the caller's favor).
		{ ...mcp.tools, ...clientTools },
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
			detail: {
				tokens: Math.round(totalTokens),
				steps: raw.steps,
				stream: body.stream === true,
				...(clientToolNames.size ? { clientTools: clientToolNames.size } : {})
			}
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

	const toOaiCall = (c: { toolCallId: string; toolName: string; input: unknown }, index: number) => ({
		index,
		id: c.toolCallId,
		type: 'function' as const,
		function: { name: c.toolName, arguments: JSON.stringify(c.input ?? {}) }
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
				let clientCallIndex = 0;
				try {
					controller.enqueue(sse(chunk({ role: 'assistant' })));
					for await (const part of (await result).fullStream) {
						if (part.type === 'text-delta' && part.text) {
							controller.enqueue(sse(chunk({ content: part.text })));
						} else if (part.type === 'tool-call' && clientToolNames.has(part.toolName)) {
							// A caller tool: surface the complete call in one chunk —
							// valid OpenAI streaming, and simpler for every client.
							controller.enqueue(
								sse(chunk({ tool_calls: [toOaiCall(part, clientCallIndex++)] }))
							);
						}
						// Server tool-calls/results and reasoning stay internal.
					}
					controller.enqueue(
						sse({ ...chunk({}, clientCallIndex > 0 ? 'tool_calls' : 'stop'), usage: oaiUsage() })
					);
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

		// Calls the loop could not execute = the caller's tools. Hand them back
		// OpenAI-style; the caller executes and returns tool-role messages.
		const pending = (result.toolCalls ?? []).filter((c) => clientToolNames.has(c.toolName));
		if (pending.length > 0) {
			return json({
				id,
				object: 'chat.completion',
				created,
				model,
				choices: [
					{
						index: 0,
						message: {
							role: 'assistant',
							content: result.text || null,
							tool_calls: pending.map(toOaiCall)
						},
						finish_reason: 'tool_calls'
					}
				],
				usage: oaiUsage()
			});
		}

		let content = result.text;
		if (jsonMode) {
			const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(content);
			if (fenced) content = fenced[1];
		}
		return json({
			id,
			object: 'chat.completion',
			created,
			model,
			choices: [
				{
					index: 0,
					message: { role: 'assistant', content },
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

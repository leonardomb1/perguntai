import { json } from '@sveltejs/kit';
import { createAgentUIStreamResponse } from 'ai';
import { env } from '$env/dynamic/private';
import { authenticateRequest } from '$lib/server/auth';
import { connectMcpTools } from '$lib/server/mcp';
import { buildAgent } from '$lib/server/agent';
import { withHeartbeat } from '$lib/server/heartbeat';
import { beginRun, liveStreamKey, recordStream } from '$lib/server/live-streams';
import { getUserSettings } from '$lib/server/settings';
import { getAccessEntry, getEffectiveOrgPrompt, resolveModel } from '$lib/server/access';
import { addUsage, usageToday, weightedTokens } from '$lib/server/usage';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	// Per-user daily token limit (admin-configured). Rejected outright when
	// already exhausted; otherwise the REMAINING budget is handed to the agent
	// as a stop condition, so a multi-step run halts once it spends it instead
	// of blowing past the limit unchecked.
	const access = await getAccessEntry(user.username);
	let tokenBudget: number | null = null;
	if (access?.maxDailyTokens) {
		const used = await usageToday(user.username);
		if (used >= access.maxDailyTokens) {
			return json(
				{ error: 'Limite diário de tokens atingido — fale com o administrador ou tente amanhã.' },
				{ status: 429 }
			);
		}
		tokenBudget = access.maxDailyTokens - used;
	}

	const { messages, conversationId, model: requestedModel } = await request.json();

	// Anthropic requires every tool_use block's `input` to be an OBJECT. A tool
	// call the SDK marked invalid (e.g. a client-resolved askUser whose input
	// tripped validation) stores `input: undefined` and moves the raw value to
	// `rawInput`; re-sending that 400s ("tool_use.input: Input should be an
	// object"). Recover the object from rawInput, else default to {}.
	sanitizeToolInputs(messages);

	// The client picks a model per conversation; validate it against the user's
	// allow-list server-side (never trust the client) — an ineligible or unknown
	// value silently falls back to the default.
	const model = await resolveModel(user.username, typeof requestedModel === 'string' ? requestedModel : '');

	// Settings drive personalization (names, custom instructions) and carry the
	// user's own Windmill token — MCP and runPython act with THEIR permissions.
	const settings = await getUserSettings(user.username);
	// Admin-granted: may the model mutate the Windmill workspace, or only read
	// and run? `access` is already loaded above, so this costs nothing.
	const mcp = await connectMcpTools(
		{ windmill: settings.windmillToken, tabula: settings.tabulaToken },
		{ allowWrites: access?.windmillWrite === true }
	);

	// Token accounting: accumulate each step's usage, persist once at the end.
	let totalTokens = 0;
	// Raw breakdown for the diagnostic log (set DEBUG_USAGE=1 to print it) — lets
	// us verify the provider actually reports cache read/write splits so the
	// cost-weighting is correct rather than falling back to full-price input.
	const raw = { input: 0, noCache: 0, cacheRead: 0, cacheWrite: 0, output: 0, steps: 0 };

	// The run is DECOUPLED from the client connection: it aborts on an explicit
	// stop, on a newer send for the same conversation, or at the hard timeout —
	// not when the socket drops. The stream is teed into a buffer so a client
	// that lost its connection resumes via GET /api/chat/{id}/stream.
	const conversation = typeof conversationId === 'string' ? conversationId : '';
	const streamKey = liveStreamKey(user.username, conversation);
	const runSignal = beginRun(user.username, conversation);

	// Keepalive comments bridge the long first-token silences of CPU inference,
	// which otherwise get the socket killed by mobile networks (see heartbeat.ts).
	return recordStream(streamKey, withHeartbeat(await createAgentUIStreamResponse({
		agent: await buildAgent(
			user,
			settings,
			mcp.tools,
			typeof conversationId === 'string' ? conversationId : '',
			await getEffectiveOrgPrompt(user.profile),
			tokenBudget,
			model
		),
		uiMessages: messages,
		// NOT request.signal — a mobile network switch mid-run used to abort the
		// whole (CPU-expensive) response. See beginRun above for what aborts it.
		abortSignal: runSignal,
		onStepEnd: (event) => {
			// Cost-weighted accounting (cache reads 0.1×, writes 1.25×) — with
			// prompt caching on, raw counts would overstate spend ~10×.
			totalTokens += weightedTokens(event.usage);
			const u = event.usage;
			const d = u?.inputTokenDetails;
			raw.steps += 1;
			raw.input += u?.inputTokens ?? 0;
			raw.noCache += d?.noCacheTokens ?? 0;
			raw.cacheRead += d?.cacheReadTokens ?? 0;
			raw.cacheWrite += d?.cacheWriteTokens ?? 0;
			raw.output += u?.outputTokens ?? 0;
		},
		onFinish: async () => {
			await mcp.close();
			// One line per message: raw provider counts + the weighted result. If
			// cacheRead/cacheWrite are 0 while input is large, the provider isn't
			// reporting the cache split and the weighting is off (see weightedTokens).
			if (env.DEBUG_USAGE === '1') {
				console.log(
					`[usage] ${user.username} model=${model} steps=${raw.steps} ` +
						`input=${raw.input} noCache=${raw.noCache} cacheRead=${raw.cacheRead} ` +
						`cacheWrite=${raw.cacheWrite} output=${raw.output} → weighted=${Math.round(totalTokens)}`
				);
			}
			await addUsage(user.username, totalTokens, {
				input: raw.input,
				cacheRead: raw.cacheRead,
				cacheWrite: raw.cacheWrite,
				output: raw.output
			}).catch((e) => console.warn('usage tracking failed:', e));
		},
		// Surface the real failure to the UI instead of the SDK's masked
		// "An error occurred." (full details stay in the server log).
		onError: (error) => {
			console.error('chat stream error:', error);
			const message = error instanceof Error ? error.message : String(error);
			return message.slice(0, 300);
		}
	})));
};

/**
 * Ensure every tool part's `input` is a plain object so Anthropic doesn't reject
 * the re-sent tool_use. Static tools whose input failed validation carry the raw
 * value in `rawInput` with `input` undefined — recover it, else fall back to {}.
 */
function sanitizeToolInputs(messages: unknown): void {
	if (!Array.isArray(messages)) return;
	for (const msg of messages) {
		const parts = (msg as { parts?: unknown })?.parts;
		if (!Array.isArray(parts)) continue;
		for (const p of parts) {
			const part = p as { type?: unknown; input?: unknown; rawInput?: unknown };
			const type = part?.type;
			if (typeof type !== 'string' || !(type.startsWith('tool-') || type === 'dynamic-tool')) continue;

			const isObj = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
			if (isObj(part.input)) continue;

			if (typeof part.input === 'string') {
				try {
					const parsed = JSON.parse(part.input);
					if (isObj(parsed)) {
						part.input = parsed;
						continue;
					}
				} catch {
					/* fall through */
				}
			}
			if (typeof part.rawInput === 'string') {
				try {
					const parsed = JSON.parse(part.rawInput);
					if (isObj(parsed)) {
						part.input = parsed;
						continue;
					}
				} catch {
					/* fall through */
				}
			} else if (isObj(part.rawInput)) {
				part.input = part.rawInput;
				continue;
			}
			part.input = {};
		}
	}
}

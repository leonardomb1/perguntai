import { json } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import { generateText, stepCountIs, type ToolSet } from 'ai';
import {
	anthropic,
	DEFAULT_MODEL,
	isKnownModel,
	modelMaxOutputTokens,
	modelSupportsServerTools,
	resolveLanguageModel
} from '$lib/server/models';
import { agentTelemetry } from '$lib/server/telemetry';
import { loadFlow } from '$lib/server/flows';
import { appendTraceStep, finishTrace, startTrace } from '$lib/server/flow-traces';
import { openCreds } from '$lib/server/seal';
import { getUserSettings } from '$lib/server/settings';
import { getAccessEntry } from '$lib/server/access';
import { addUsage, usageToday, weightedTokens } from '$lib/server/usage';
import { connectMcpTools } from '$lib/server/mcp';
import {
	pythonTool,
	starrocksQueryTool,
	tableSchemaTool,
	warehouseCatalogTool
} from '$lib/server/tools';
import type { AuthUser } from '$lib/server/auth';
import type { RequestHandler } from './$types';

/**
 * Agent-step callback for DEPLOYED flows. Windmill workers call this (no
 * bearer token — they authenticate with the per-deployment secret minted at
 * activation), and the agent runs HERE: owner's sealed StarRocks credentials,
 * the same tools as chat, and usage accounted against the owner's budget.
 * Errors return 200 with {error} so the compiled rawscript surfaces them as
 * the step failure inside Windmill.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as {
		flowId?: string;
		owner?: string;
		nodeId?: string;
		secret?: string;
		context?: unknown;
		/** Windmill ROOT FLOW job id — ties the trace to the runs panel. */
		jobId?: string;
	};
	if (!body.flowId || !body.owner || !body.nodeId || !body.secret) {
		return json({ error: 'Malformed agent-step request' }, { status: 400 });
	}

	const record = await loadFlow(body.owner, body.flowId);
	const deployment = record?.deployment;
	if (!record || !deployment || !secretsMatch(deployment.secret, body.secret)) {
		// One answer for unknown flow / not deployed / bad secret — no oracle.
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	// Always execute the DEPLOYED version's node — never a newer draft.
	const version = record.versions.find((v) => v.version === deployment.deployedVersion);
	const node = version?.spec.nodes.find((n) => n.id === body.nodeId);
	if (!node || node.kind !== 'agent') {
		return json({ error: `No agent node "${body.nodeId}" in the deployed version` });
	}

	const credentials = openCreds(deployment.sealedCreds);
	if (!credentials) {
		return json({ error: 'Sealed credentials unreadable — re-activate the flow in PerguntAI' });
	}

	// The owner's daily token budget covers scheduled runs too.
	const access = await getAccessEntry(body.owner);
	if (access?.maxDailyTokens && (await usageToday(body.owner)) >= access.maxDailyTokens) {
		return json({ error: 'Daily token limit reached for the flow owner' });
	}

	const settings = await getUserSettings(body.owner);
	const owner: AuthUser = { username: body.owner, displayName: null, credentials };
	const model = node.config.model && isKnownModel(node.config.model) ? node.config.model : DEFAULT_MODEL;

	const grants = new Set(node.config.tools);
	const tools: ToolSet = {};
	if (grants.has('warehouse')) {
		tools.queryDatabase = starrocksQueryTool(credentials);
		tools.listTables = warehouseCatalogTool(credentials);
		tools.getTableSchema = tableSchemaTool(credentials);
	}
	if (grants.has('python')) {
		// Flows don't carry conversation/shared-library documents — empty scope.
		tools.runPython = pythonTool(credentials, `flow:${record.id}`, settings.windmillToken, []);
	}
	if (grants.has('web') && modelSupportsServerTools(model)) {
		tools.web_search = anthropic.tools.webSearch_20260209({
			maxUses: 3,
			userLocation: { type: 'approximate', country: 'BR', timezone: 'America/Sao_Paulo' }
		});
	}
	const mcp = grants.has('windmill')
		? await connectMcpTools({ windmill: settings.windmillToken, tabula: settings.tabulaToken })
		: { tools: {} as ToolSet, close: async () => {} };

	// Incremental trace so the flows page can show the agent working while the
	// run is still in flight (best-effort — never blocks the step itself).
	const jobId = typeof body.jobId === 'string' && body.jobId ? body.jobId : `sem-job-${Date.now()}`;
	const nodeId = body.nodeId;
	const trace = {
		start: () => startTrace(body.owner!, record.id, jobId, nodeId).catch(() => {}),
		step: (step: { reasoning?: string; tools?: { name: string; input: string }[] }) =>
			appendTraceStep(body.owner!, record.id, jobId, nodeId, {
				at: new Date().toISOString(),
				...step
			}).catch(() => {}),
		finish: (outcome: { text?: string; error?: string }) =>
			finishTrace(body.owner!, record.id, jobId, nodeId, outcome).catch(() => {})
	};
	await trace.start();

	try {
		const result = await generateText({
			model: resolveLanguageModel(model),
			maxOutputTokens: modelMaxOutputTokens(model),
			telemetry: agentTelemetry('flow-step'),
			system:
				`You are PerguntAI executing one step of the automated flow "${record.name}" — ` +
				'no human is watching this run. Follow the step instructions, use the available tools as ' +
				'needed, and END with a concise final answer in Portuguese, written to be readable as the ' +
				'body of a notification e-mail (plain prose, no markdown headers).',
			messages: [
				{
					role: 'user',
					content:
						node.config.prompt +
						'\n\nContexto do passo anterior (JSON):\n' +
						JSON.stringify(truncateContext(body.context))
				}
			],
			tools: { ...tools, ...mcp.tools },
			stopWhen: stepCountIs(8),
			onStepFinish: (step) => {
				const reasoning = (step.reasoningText ?? '').trim();
				const calls = step.toolCalls.map((call) => ({
					name: call.toolName,
					input: JSON.stringify('input' in call ? call.input : {}).slice(0, 400)
				}));
				if (reasoning || calls.length > 0) {
					void trace.step({
						...(reasoning ? { reasoning: reasoning.slice(0, 1000) } : {}),
						...(calls.length > 0 ? { tools: calls } : {})
					});
				}
			}
		});
		await addUsage(body.owner, weightedTokens(result.totalUsage)).catch(() => {});
		await trace.finish({ text: result.text });
		return json({ text: result.text });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Agent step failed';
		console.error(`flow agent-step ${body.flowId}/${body.nodeId} failed:`, message);
		await trace.finish({ error: message.slice(0, 300) });
		return json({ error: message.slice(0, 300) });
	} finally {
		await mcp.close().catch(() => {});
	}
};

function secretsMatch(expected: string, provided: string): boolean {
	const a = Buffer.from(expected);
	const b = Buffer.from(provided);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Detect results can be 1000 rows — the agent needs a sample, not the dump. */
function truncateContext(context: unknown): unknown {
	if (!context || typeof context !== 'object') return context ?? null;
	const obj = context as Record<string, unknown>;
	if (Array.isArray(obj.data) && obj.data.length > 50) {
		return { ...obj, data: obj.data.slice(0, 50), truncated: `${obj.data.length} rows total, showing 50` };
	}
	return context;
}

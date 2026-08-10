import { ToolLoopAgent, stepCountIs, type ToolSet } from 'ai';
import { sortTools } from './agent';
import {
	starrocksQueryTool,
	warehouseCatalogTool,
	tableSchemaTool,
	upsertFlowTool,
	getFlowTool
} from './tools';
import { weightedTokens } from './usage';
import { agentTelemetry } from './telemetry';
import {
	DEFAULT_MODEL,
	modelMaxOutputTokens,
	modelPromptCache,
	modelThinking,
	resolveLanguageModel
} from './models';
import type { AuthUser } from './auth';
import type { UserSettings } from './settings';

/**
 * The dedicated flow-builder agent, used by the Flows page's builder chat. It is
 * a FOCUSED counterpart to buildAgent: its only job is to design and save flows
 * with upsertFlow/getFlow, plus read-only warehouse inspection and the Windmill
 * facade so it can ground SQL/prompts in real tables and find notify scripts.
 * These tools live ONLY here — the main chat dropped them to keep its prefix
 * lean.
 */
export async function buildFlowBuilderAgent(
	user: AuthUser,
	settings: UserSettings,
	mcpTools: ToolSet,
	conversationId: string,
	flowId: string | null,
	/** Whose flow store to write — the owner (== caller for a new flow; may differ
	 *  when an admin edits someone else's flow). */
	ownerUsername: string,
	/** Department stamped on a newly-created flow (from the page's picker). */
	departmentId: string | null,
	model: string = DEFAULT_MODEL,
	tokenBudget: number | null = null
) {
	const flowContext = flowId
		? `You are editing the EXISTING flow with id "${flowId}". ALWAYS call getFlow with flowId "${flowId}" first to load the current graph, then save changes by calling upsertFlow with that SAME flowId and the FULL graph (keep node ids stable). `
		: `You are creating a NEW flow. Design it together with the user, then create it by calling upsertFlow and OMITTING flowId. `;

	const instructions =
		`You are PerguntAI's flow builder — you help ${settings.fullName || user.username} design and edit automation flows, and you SAVE them by calling the upsertFlow tool. ` +
		flowContext +
		'A flow is a small automation TREE (branches never re-join — duplicate steps per branch instead) made of: EXACTLY ONE trigger (a 5-field cron interpreted in America/Sao_Paulo, or manual); optional sqlCheck gates (a single read-only SELECT returning ONE scalar, compared against a threshold — label the two outgoing edges branch "trip" when the condition is met and "pass" when it is not); agent steps (a prompt plus tool grants, run as the flow owner); and notify steps (an allowlisted Windmill script plus recipients). ' +
		'To design well, GROUND everything in reality: call listTables and getTableSchema (and read-only queryDatabase) so your SQL and agent prompts reference real tables and columns; call windmill_listScripts / windmill_getScriptByPath to pick a valid notify script and see its inputs. ' +
		'ALWAYS send the COMPLETE graph to upsertFlow. If it returns ok:false, fix EVERY listed error and call it again with the full corrected graph — the validator passing, not your own judgement, is the success signal; only once it returns ok:true tell the user it is saved. ' +
		'Saved versions are DRAFTS: a flow only runs after the user ACTIVATES a version with the button on this page (editing an active flow changes nothing that runs until they re-activate) — remind them to activate. ' +
		'Explain your design decisions in plain language as you go. Answer in the language the user writes in; be concise and concrete.';

	// Read-only warehouse access — the builder inspects to design, never writes.
	const tools = sortTools({
		upsertFlow: upsertFlowTool(ownerUsername, conversationId, model, {
			departmentId,
			editor: user.username
		}),
		getFlow: getFlowTool(ownerUsername),
		queryDatabase: starrocksQueryTool(user.credentials, { allowWrites: false }),
		listTables: warehouseCatalogTool(user.credentials),
		getTableSchema: tableSchemaTool(user.credentials),
		...mcpTools
	});

	// Anthropic-only features, gated per model (see ./models).
	const promptCache = modelPromptCache(model);
	const thinking = modelThinking(model);

	return new ToolLoopAgent({
		model: resolveLanguageModel(model),
		maxOutputTokens: modelMaxOutputTokens(model),
		telemetry: agentTelemetry('flow-builder'),
		tools,
		instructions: {
			role: 'system',
			...(promptCache
				? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } } }
				: {}),
			content: instructions
		},
		prepareStep: ({ messages }) => {
			if (!promptCache) return {};
			const last = messages[messages.length - 1];
			if (!last || (last.role !== 'user' && last.role !== 'tool')) return {};
			return {
				messages: messages.map((message, i) =>
					i === messages.length - 1
						? {
								...message,
								providerOptions: {
									...message.providerOptions,
									anthropic: { cacheControl: { type: 'ephemeral' } }
								}
							}
						: message
				) as typeof messages
			};
		},
		stopWhen: [
			stepCountIs(12),
			({ steps }) =>
				tokenBudget !== null &&
				steps.reduce((sum, step) => sum + weightedTokens(step.usage), 0) >= tokenBudget
		],
		...(thinking
			? {
					providerOptions: {
						anthropic: { thinking: { type: 'adaptive', display: 'summarized' } }
					}
				}
			: {})
	});
}

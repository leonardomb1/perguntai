import { ToolLoopAgent, stepCountIs } from 'ai';
import { env } from '$env/dynamic/private';
import {
	tools as localTools,
	starrocksQueryTool,
	tableSchemaTool,
	warehouseCatalogTool,
	chartTool,
	diagramTool,
	askUserTool
} from './tools';
import { cachedPrepareStep, sortTools } from './agent';
import { verifyEmbedKey } from './embedKeys';
import { agentTelemetry } from './telemetry';
import { weightedTokens } from './usage';
import {
	DEFAULT_MODEL,
	isKnownModel,
	modelMaxOutputTokens,
	modelPromptCache,
	modelThinking,
	resolveLanguageModel
} from './models';

/**
 * Embedded chat (/embed): anonymous, read-only conversations with the
 * warehouse, meant to be iframed into intranet portals. The security boundary
 * is the DEDICATED StarRocks service account — everything anyone can see
 * through this surface is exactly what that account is granted, so scope it
 * to curated views (never reuse the sync user or a personal account).
 *
 * Deliberately stripped: no MCP, no sandbox, no memory, no skills, no
 * documents, no exports — and fully stateless: history lives in the visitor's
 * browser, nothing is stored server-side. Cost control without identity:
 * a message cap per conversation, a per-IP throttle, and one shared daily
 * token budget for the whole surface (usage tagged under EMBED_USAGE_USER).
 */

/** Synthetic usage/audit identity — shows up as its own row in Estatísticas. */
export const EMBED_USAGE_USER = '_embed';

const intEnv = (value: string | undefined, fallback: number): number => {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export function embedConfig() {
	const username = env.EMBED_STARROCKS_USER ?? '';
	const password = env.EMBED_STARROCKS_PASSWORD ?? '';
	// Restricted to the sonnet tier or lower whatever the env says — the embed
	// surface never gets an opus/fable-class model.
	const requested = env.EMBED_MODEL ?? '';
	const model =
		requested && isKnownModel(requested) && !/opus|fable/i.test(requested)
			? requested
			: DEFAULT_MODEL;
	return {
		configured: Boolean(username && password),
		credentials: { username, password },
		model,
		/** User messages allowed per conversation before the client must reset. */
		maxMessages: intEnv(env.EMBED_MAX_MESSAGES, 10),
		/** Shared daily weighted-token budget for the whole embed surface. */
		dailyTokens: intEnv(env.EMBED_DAILY_TOKENS, 1_000_000),
		/** CSP frame-ancestors for /embed — who may iframe it. */
		frameAncestors: env.EMBED_ALLOWED_ORIGINS || "'self'"
	};
}

/**
 * Resolve what one embed request may do: an embed key (per-portal service
 * account + limits, minted in the console) wins; the env service account is
 * the keyless fallback. Null → no valid access path.
 */
export interface EmbedAccess {
	credentials: { username: string; password: string };
	model: string;
	maxMessages: number;
	dailyTokens: number;
	/** Per-key usage/audit identity so Estatísticas attributes per portal. */
	usageUser: string;
	keyId?: string;
	keyLabel?: string;
}

export async function resolveEmbedAccess(rawKey?: string | null): Promise<EmbedAccess | null> {
	const config = embedConfig();
	if (rawKey) {
		const access = await verifyEmbedKey(rawKey);
		if (!access) return null; // an invalid key never falls back to the env account
		return {
			credentials: access.credentials,
			model: config.model,
			maxMessages: access.maxMessages ?? config.maxMessages,
			dailyTokens: access.dailyTokens ?? config.dailyTokens,
			usageUser: `${EMBED_USAGE_USER}-${access.id.slice(0, 8)}`,
			keyId: access.id,
			keyLabel: access.label
		};
	}
	if (!config.configured) return null;
	return {
		credentials: config.credentials,
		model: config.model,
		maxMessages: config.maxMessages,
		dailyTokens: config.dailyTokens,
		usageUser: EMBED_USAGE_USER
	};
}

/**
 * The lean agent for one embed request. Same caching discipline as the main
 * agent (byte-stable sorted tools, 1h system breakpoint, rolling message
 * breakpoints) — embed traffic is exactly the bursty, repeated-prefix shape
 * prompt caching pays off on.
 */
export function buildEmbedAgent(
	access: EmbedAccess,
	orgSystemPrompt: string,
	tokenBudget: number | null
) {
	const model = access.model;
	const promptCache = modelPromptCache(model);
	const thinking = modelThinking(model);

	return new ToolLoopAgent({
		model: resolveLanguageModel(model),
		telemetry: agentTelemetry('embed-chat'),
		tools: sortTools({
			...localTools,
			queryDatabase: starrocksQueryTool(access.credentials, { allowWrites: false }),
			listTables: warehouseCatalogTool(access.credentials),
			getTableSchema: tableSchemaTool(access.credentials),
			renderChart: chartTool,
			renderDiagram: diagramTool,
			askUser: askUserTool
		}),
		prepareStep: cachedPrepareStep(promptCache),
		instructions: {
			role: 'system',
			...(promptCache
				? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } } }
				: {}),
			content:
				'You are PerguntAI, a data-analytics assistant embedded in an internal portal, answering ' +
				'anonymous visitors in READ-ONLY mode against the organization’s data warehouse. ' +
				(orgSystemPrompt
					? `The organization's administrators set these standing instructions: <org_instructions>${orgSystemPrompt}</org_instructions> `
					: '') +
				'For any warehouse question, FIRST call listTables to see the available tables/views, THEN getTableSchema for the columns of the ones you’ll query; ' +
				'always write database-qualified table names like gold.table_name — there is no default database. ' +
				'You can only read: never attempt INSERT/UPDATE/DDL, and if asked, say this surface is read-only. ' +
				'When presenting data: use a markdown table when exact values matter or the result is small; ' +
				'use renderChart for visual patterns (one chart per insight, at most 8 series) and renderDiagram (Mermaid) for flows and relationships. ' +
				'When a request is ambiguous in a way a few concrete options would resolve, call askUser with 2–5 short options instead of guessing. ' +
				'There are no user accounts here: never claim to remember previous conversations, and do not ask for personal data. ' +
				'Answer in the same language the user writes in. Be concise and direct. ' +
				'For greetings or small talk, reply in a single short sentence.'
		},
		maxOutputTokens: modelMaxOutputTokens(model),
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

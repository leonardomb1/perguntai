/**
 * Shared model TYPES and pure helpers — safe to import from both server and
 * client (no env access, no asset imports).
 *
 * The actual catalog lives server-side in `$lib/server/models` (built from the
 * deployment's env: the built-in Claude entries plus MODELS_EXTRA), and reaches
 * the client through GET /api/models. The FIRST/default entry is the model
 * every user gets with no extra grant; anything beyond it is allow-listed per
 * user by an admin (see access.ts).
 *
 * We deliberately do NOT route reasoning-vs-not through a classifier model:
 * Claude's `thinking: {type:'adaptive'}` (and the <think> extraction on
 * reasoning models served over openai-compatible endpoints) already lets the
 * model self-pace per request, at no extra round-trip and — crucially —
 * without the mid-conversation model switch that would invalidate the large
 * tool+schema prompt cache. Model choice is therefore per-conversation
 * (stable for the pane's lifetime), user-selected from the allow-list.
 */

/** Display family of a model — drives the logo shown in the picker. Any string
 *  is accepted (deployments name their own providers in MODELS_EXTRA); the
 *  known values below have a dedicated logo, everything else falls back to a
 *  generic mark (see providers.ts). */
export type Provider = string;

/** Well-known provider families with dedicated logos. */
export const KNOWN_PROVIDERS = ['anthropic', 'openai', 'google', 'qwen', 'ollama'] as const;

export interface ModelOption {
	id: string;
	label: string;
	/** One-line hint shown in the picker. */
	hint: string;
	provider: Provider;
	/**
	 * Whether the deployment's provider workspace serves Anthropic SERVER tools
	 * (web_search, code_execution) for this model. Provisioned per-model on
	 * Azure Foundry — so web search is gated per-model, not just per-deployment.
	 * Always false for non-Anthropic models.
	 */
	serverTools: boolean;
}

/** localStorage key for the user's sticky model pick (shared by chat + flows). */
export const MODEL_STORAGE_KEY = 'perguntai:model';

/** Label lookup over a fetched model list, falling back to the raw id. */
export function modelLabel(models: Pick<ModelOption, 'id' | 'label'>[], id: string): string {
	return models.find((mo) => mo.id === id)?.label ?? id;
}

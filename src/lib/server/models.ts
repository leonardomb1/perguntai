import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { extractReasoningMiddleware, wrapLanguageModel, type LanguageModel } from 'ai';
import { env } from '$env/dynamic/private';
import type { ModelOption } from '$lib/models';

/**
 * The EFFECTIVE model registry for this deployment, and the only place that
 * knows how to turn a model id into a live AI-SDK LanguageModel.
 *
 * Two execution kinds cover every provider we care about:
 *  - 'anthropic'          — the native Anthropic path (direct API or Azure AI
 *                           Foundry). Keeps the Claude-only optimizations:
 *                           prompt-cache breakpoints, adaptive thinking, and
 *                           server tools (web_search).
 *  - 'openai-compatible'  — any /v1 chat-completions endpoint: Ollama, OpenAI,
 *                           Groq, vLLM, OpenRouter, Gemini's compat endpoint…
 *                           Reasoning models that emit <think> tags (Qwen,
 *                           DeepSeek) get their reasoning extracted for the UI
 *                           via `reasoningTag`.
 *
 * The built-in Claude entries are served only when Anthropic credentials are
 * configured. Everything else comes from MODELS_EXTRA (JSON, see .env.example)
 * so each deployment declares its own catalog without a code change.
 */
export interface ServerModelOption extends ModelOption {
	/** Which execution path serves this model. */
	kind: 'anthropic' | 'openai-compatible';
	/** Endpoint for openai-compatible entries (must end in /v1). */
	baseUrl?: string;
	/** API key for the endpoint (Ollama ignores it; a placeholder is sent). */
	apiKey?: string;
	/** Upstream model name when it differs from the app-unique `id`. */
	upstreamModel?: string;
	/** Reasoning tag emitted by the model ("think" → <think>…</think>). */
	reasoningTag?: string;
	/** Anthropic prompt-cache breakpoints apply to this model. */
	promptCache: boolean;
	/** Anthropic adaptive thinking applies to this model. */
	thinking: boolean;
	/**
	 * Per-request output ceiling. Claude gets a generous 32k (one large tool
	 * call — an ephemeral Typst template plus report content — easily passes
	 * 4096). Local/openai-compatible models default to 8k: on CPU at ~15 tok/s
	 * a runaway reasoning loop otherwise churns for many minutes, and 8k still
	 * fits any sane tool call. Overridable per entry in MODELS_EXTRA.
	 */
	maxOutputTokens: number;
}

const anthropicConfigured = Boolean(env.ANTHROPIC_FOUNDRY_BASE_URL || env.ANTHROPIC_API_KEY);

/**
 * Azure Foundry provisions Anthropic SERVER tools (web_search) per-model, and
 * this workspace lacks them for Sonnet 5 / Opus 5 — sending web_search there
 * 400s. The DIRECT Anthropic API has no such gating: web_search_20260209 is
 * available on every Claude model in the catalog below. So the gap is a
 * property of the Foundry deployment, not of the models.
 */
const foundryServerToolGap = Boolean(env.ANTHROPIC_FOUNDRY_BASE_URL);

/**
 * Model access goes through Microsoft Azure AI Foundry when
 * ANTHROPIC_FOUNDRY_BASE_URL is set (e.g. https://<resource>.services.ai.azure.com/anthropic/v1),
 * and falls back to the direct Anthropic API otherwise. Foundry serves the
 * same Messages API shape, so the provider only needs a different base URL
 * and key; the `api-key` header is added because Azure accepts that form.
 */
export const anthropic = env.ANTHROPIC_FOUNDRY_BASE_URL
	? createAnthropic({
			baseURL: env.ANTHROPIC_FOUNDRY_BASE_URL,
			apiKey: env.ANTHROPIC_FOUNDRY_API_KEY,
			headers: { 'api-key': env.ANTHROPIC_FOUNDRY_API_KEY ?? '' }
		})
	: createAnthropic({
			apiKey: env.ANTHROPIC_API_KEY
		});

/** The built-in Claude catalog (all confirmed available through Azure Foundry).
 *  `serverTools` marks whether the Foundry workspace serves Anthropic SERVER
 *  tools (web_search, code_execution) for that model — they are provisioned
 *  per-model there, not per-deployment. */
const CLAUDE_MODELS: ServerModelOption[] = [
	{
		id: 'claude-sonnet-5',
		label: 'Sonnet 5',
		hint: 'Rápido e capaz — padrão',
		provider: 'anthropic',
		kind: 'anthropic',
		// Foundry-only gap (see foundryServerToolGap) — fine on the direct API.
		serverTools: !foundryServerToolGap,
		promptCache: true,
		thinking: true,
		maxOutputTokens: 32_000
	},
	{
		id: 'claude-opus-4-8',
		label: 'Opus 4.8',
		hint: 'Mais autônomo, raciocínio profundo',
		provider: 'anthropic',
		kind: 'anthropic',
		serverTools: true,
		promptCache: true,
		thinking: true,
		maxOutputTokens: 32_000
	},
	{
		id: 'claude-fable-5',
		label: 'Fable 5',
		hint: 'Máxima capacidade, tarefas mais difíceis',
		provider: 'anthropic',
		kind: 'anthropic',
		serverTools: true,
		promptCache: true,
		thinking: true,
		maxOutputTokens: 32_000
	},
	{
		id: 'claude-opus-5',
		label: 'Opus 5',
		hint: 'Codificação e trabalho agêntico de ponta',
		provider: 'anthropic',
		kind: 'anthropic',
		// Foundry-only gap (see foundryServerToolGap) — fine on the direct API.
		serverTools: !foundryServerToolGap,
		promptCache: true,
		thinking: true,
		maxOutputTokens: 32_000
	}
];

/** One MODELS_EXTRA entry as the deployment writes it (see .env.example). */
interface ExtraModelConfig {
	id?: string;
	label?: string;
	hint?: string;
	/** Display/logo family shown in the picker (qwen, openai, google, ollama…). */
	provider?: string;
	kind?: 'anthropic' | 'openai-compatible';
	baseUrl?: string;
	apiKey?: string;
	/** Name of the env var holding the key — keeps secrets out of the JSON. */
	apiKeyEnv?: string;
	model?: string;
	reasoningTag?: string;
	maxOutputTokens?: number;
}

function parseExtraModels(): ServerModelOption[] {
	const raw = env.MODELS_EXTRA?.trim();
	if (!raw) return [];
	let entries: unknown;
	try {
		entries = JSON.parse(raw);
	} catch (error) {
		console.error('[models] MODELS_EXTRA is not valid JSON — ignoring it:', error);
		return [];
	}
	if (!Array.isArray(entries)) {
		console.error('[models] MODELS_EXTRA must be a JSON array — ignoring it');
		return [];
	}
	const out: ServerModelOption[] = [];
	for (const entry of entries as ExtraModelConfig[]) {
		if (!entry || typeof entry !== 'object' || !entry.id || !entry.label) {
			console.error('[models] MODELS_EXTRA entry missing id/label — skipped:', entry);
			continue;
		}
		const kind = entry.kind ?? (entry.provider === 'anthropic' ? 'anthropic' : 'openai-compatible');
		if (kind === 'openai-compatible' && !entry.baseUrl) {
			console.error(`[models] MODELS_EXTRA "${entry.id}" needs baseUrl — skipped`);
			continue;
		}
		if (kind === 'anthropic' && !anthropicConfigured) {
			console.error(`[models] MODELS_EXTRA "${entry.id}" is kind anthropic but no Anthropic credentials are configured — skipped`);
			continue;
		}
		out.push({
			id: entry.id,
			label: entry.label,
			hint: entry.hint ?? '',
			provider: entry.provider ?? (kind === 'anthropic' ? 'anthropic' : 'ollama'),
			kind,
			baseUrl: entry.baseUrl,
			apiKey: entry.apiKeyEnv ? env[entry.apiKeyEnv] : entry.apiKey,
			upstreamModel: entry.model,
			reasoningTag: entry.reasoningTag,
			// Anthropic-only features follow the execution kind.
			serverTools: false,
			promptCache: kind === 'anthropic',
			thinking: kind === 'anthropic',
			maxOutputTokens:
				typeof entry.maxOutputTokens === 'number' && entry.maxOutputTokens > 0
					? entry.maxOutputTokens
					: kind === 'anthropic'
						? 32_000
						: 8_192
		});
	}
	return out;
}

const extraModels = parseExtraModels();

/** The deployment's effective catalog. Claude entries require credentials —
 *  except when nothing else is configured either, where they are kept so a
 *  bare deployment still boots with the historical default (and fails at call
 *  time with a clear auth error, as before). */
export const MODELS: ServerModelOption[] =
	anthropicConfigured || extraModels.length === 0
		? [...CLAUDE_MODELS, ...extraModels]
		: extraModels;

export const MODEL_IDS = MODELS.map((mo) => mo.id);

/** The model every user gets without an explicit grant: DEFAULT_MODEL_ID when
 *  set and known, else the first catalog entry. */
export const DEFAULT_MODEL =
	env.DEFAULT_MODEL_ID && MODEL_IDS.includes(env.DEFAULT_MODEL_ID)
		? env.DEFAULT_MODEL_ID
		: MODELS[0].id;

export function isKnownModel(id: string): boolean {
	return MODEL_IDS.includes(id);
}

export function modelLabel(id: string): string {
	return MODELS.find((mo) => mo.id === id)?.label ?? id;
}

function entryOf(id: string): ServerModelOption | undefined {
	return MODELS.find((mo) => mo.id === id);
}

/** Whether Anthropic server tools (web search etc.) are available for this model. */
export function modelSupportsServerTools(id: string): boolean {
	return entryOf(id)?.serverTools ?? false;
}

/** Whether Anthropic prompt-cache breakpoints apply to this model. */
export function modelPromptCache(id: string): boolean {
	return entryOf(id)?.promptCache ?? false;
}

/** Whether Anthropic adaptive thinking applies to this model. */
export function modelThinking(id: string): boolean {
	return entryOf(id)?.thinking ?? false;
}

/** Output ceiling for this model (see ServerModelOption.maxOutputTokens). */
export function modelMaxOutputTokens(id: string): number {
	return entryOf(id)?.maxOutputTokens ?? 32_000;
}

/**
 * Whether web search is available anywhere on this deployment — i.e. at least
 * one model serves Anthropic's server tools. Used only to decide whether to
 * show the web-search toggle; actual use is gated per-model at request time.
 */
export function webSearchAvailable(): boolean {
	return MODELS.some((mo) => mo.serverTools);
}

/** The catalog as the client sees it (server-only fields stripped). */
export function clientModels(): ModelOption[] {
	return MODELS.map(({ id, label, hint, provider, serverTools }) => ({
		id,
		label,
		hint,
		provider,
		serverTools
	}));
}

/** One provider instance per distinct endpoint, reused across requests. */
const compatProviders = new Map<string, ReturnType<typeof createOpenAICompatible>>();

function compatProvider(entry: ServerModelOption) {
	const key = `${entry.baseUrl}|${entry.apiKey ?? ''}`;
	let provider = compatProviders.get(key);
	if (!provider) {
		provider = createOpenAICompatible({
			name: entry.provider,
			baseURL: entry.baseUrl!,
			// Ollama and friends ignore the key but the OpenAI wire format sends
			// the header regardless; a placeholder keeps strict proxies happy.
			apiKey: entry.apiKey || 'unused'
		});
		compatProviders.set(key, provider);
	}
	return provider;
}

/** Turn a validated model id into a live AI-SDK language model. */
export function resolveLanguageModel(id: string): LanguageModel {
	const entry = entryOf(id) ?? entryOf(DEFAULT_MODEL)!;
	if (entry.kind === 'anthropic') return anthropic(entry.upstreamModel ?? entry.id);
	const base = compatProvider(entry)(entry.upstreamModel ?? entry.id);
	// Reasoning models on plain /v1 endpoints inline their thinking as
	// <think>…</think> text — extract it so the UI shows it as reasoning
	// instead of it leaking into the answer.
	return entry.reasoningTag
		? wrapLanguageModel({
				model: base,
				middleware: extractReasoningMiddleware({ tagName: entry.reasoningTag })
			})
		: base;
}

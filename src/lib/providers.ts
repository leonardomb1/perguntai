import anthropicLogo from '$lib/assets/anthropic.svg';
import openaiLogo from '$lib/assets/openai.svg';
import googleLogo from '$lib/assets/google.svg';
import qwenLogo from '$lib/assets/qwen.svg';
import ollamaLogo from '$lib/assets/ollama.svg';
import genericLogo from '$lib/assets/ai-generic.svg';
import type { Provider } from '$lib/models';

/**
 * Client-side provider metadata (logo + display name). Kept out of models.ts so
 * that file stays free of asset imports and safe to use on the server.
 *
 * A model's `provider` is a free string set by the deployment (MODELS_EXTRA) —
 * families registered here get their official mark (OpenAI via lobe-icons,
 * Ollama/Qwen via simple-icons, Google's multicolor "G"); anything else falls
 * back to the generic sparkle.
 */
export const PROVIDERS: Record<string, { name: string; logo: string }> = {
	anthropic: { name: 'Anthropic', logo: anthropicLogo },
	openai: { name: 'OpenAI', logo: openaiLogo },
	google: { name: 'Google', logo: googleLogo },
	qwen: { name: 'Qwen', logo: qwenLogo },
	ollama: { name: 'Ollama', logo: ollamaLogo }
};

export function providerLogo(provider: Provider): string {
	return PROVIDERS[provider]?.logo ?? genericLogo;
}

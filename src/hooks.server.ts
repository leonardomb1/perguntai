import * as Sentry from '@sentry/sveltekit';
import { sequence } from '@sveltejs/kit/hooks';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import type { Handle } from '@sveltejs/kit';
import { getTextDirection } from '$lib/paraglide/runtime';
import { paraglideMiddleware } from '$lib/paraglide/server';

// DSN-gated: with no SENTRY_DSN, Sentry.init is inert (SDK disabled), so this
// has zero effect on production until the env is set. The Vercel-AI-SDK
// integration turns the agents' telemetry (see telemetry.ts) into Sentry's AI
// Agents view; PII capture stays off (recordInputs/recordOutputs false).
Sentry.init({
	dsn: env.SENTRY_DSN,
	// Silent in dev unless explicitly opted in (SENTRY_DEV=1): dev telemetry
	// pollutes the project, and its async envelope uploads race into
	// SvelteKit's SSR render window, producing spurious "Avoid calling fetch
	// eagerly during server-side rendering" warnings in the dev console.
	enabled: !dev || env.SENTRY_DEV === '1',
	environment: env.SENTRY_ENVIRONMENT,
	tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE ? Number(env.SENTRY_TRACES_SAMPLE_RATE) : 1,
	// One switch for LLM/tool I/O capture — the AI-SDK and MCP integrations both
	// fall back to this. OFF: prompts carry warehouse rows, personal context and
	// memory, which must not leave for Sentry. (Preferred over deprecated
	// sendDefaultPii.) The AI SDK also omits I/O from its spans — see telemetry.ts.
	dataCollection: { genAI: { inputs: false, outputs: false } },
	integrations: [Sentry.vercelAIIntegration()]
});

const handleParaglide: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, ({ request, locale }) => {
		event.request = request;
		return resolve(event, {
			transformPageChunk: ({ html }) =>
				html.replace('%paraglide.lang%', locale).replace('%paraglide.dir%', getTextDirection(locale))
		});
	});

export const handle: Handle = sequence(Sentry.sentryHandle(), handleParaglide);
export const handleError = Sentry.handleErrorWithSentry();

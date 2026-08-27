import * as Sentry from '@sentry/sveltekit';
import { sequence } from '@sveltejs/kit/hooks';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import type { Handle } from '@sveltejs/kit';
import { getTextDirection } from '$lib/paraglide/runtime';
import { getCapabilities } from '$lib/server/access';
import { warmSandbox } from '$lib/server/sandbox';
import { paraglideMiddleware } from '$lib/paraglide/server';

// DSN-gated: with no SENTRY_DSN, Sentry.init is inert (SDK disabled), so this
// has zero effect on production until the env is set. The Vercel-AI-SDK
// integration turns the agents' telemetry (see telemetry.ts) into Sentry's AI
// Agents view; PII capture stays off (recordInputs/recordOutputs false).
// Skipping init entirely (not just `enabled: false`) matters: init wires the
// ESM loader hooks (import-in-the-middle via module.register — a DEP0205
// deprecation warning on Node 24+) and OTel instrumentation even when event
// sending is disabled. Dev servers stay silent unless SENTRY_DEV=1; dev
// telemetry also pollutes the project, and its async envelope uploads race
// into SvelteKit's SSR render window, producing spurious "Avoid calling
// fetch eagerly during server-side rendering" warnings.
const sentryOn = Boolean(env.SENTRY_DSN) && (!dev || env.SENTRY_DEV === '1');
if (sentryOn) {
	Sentry.init({
		dsn: env.SENTRY_DSN,
		environment: env.SENTRY_ENVIRONMENT,
		tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE ? Number(env.SENTRY_TRACES_SAMPLE_RATE) : 1,
		// One switch for LLM/tool I/O capture — the AI-SDK and MCP integrations
		// both fall back to this. OFF: prompts carry warehouse rows, personal
		// context and memory, which must not leave for Sentry. (Preferred over
		// deprecated sendDefaultPii.) The AI SDK also omits I/O from its spans —
		// see telemetry.ts.
		dataCollection: { genAI: { inputs: false, outputs: false } },
		integrations: [Sentry.vercelAIIntegration()]
	});
}

// Sandbox warm-up at boot: when the code-execution capability is already on,
// pull the OCI image and boot one VM in the background so the first user run
// is a warm ~300ms boot instead of a cold multi-second pull. Fully non-blocking
// and failure-tolerant — a host without KVM just logs the warm-up failure.
getCapabilities()
	.then((caps) => {
		// 15s delay: let the server settle first — booting the napi microVM
		// runtime during module init has been seen to hang.
		if (caps.codeExecution) warmSandbox(15_000);
	})
	.catch(() => {});

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

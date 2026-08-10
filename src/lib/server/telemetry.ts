import { env } from '$env/dynamic/private';
import type { TelemetryOptions } from 'ai';

/**
 * AI SDK telemetry for the agents, consumed by Sentry's Vercel-AI-SDK
 * integration (Sentry.init runs in hooks.server.ts). Gated on SENTRY_DSN so it
 * is a complete no-op when Sentry is not configured — zero overhead, no spans.
 *
 * PII: recordInputs/recordOutputs are OFF — prompts carry warehouse rows,
 * personal context and memory, which must not leave for Sentry. We keep the
 * operational signal (model, token counts, latency, tool calls, errors).
 */
const enabled = Boolean(env.SENTRY_DSN);

export function agentTelemetry(functionId: string): TelemetryOptions {
	return {
		isEnabled: enabled,
		functionId,
		recordInputs: false,
		recordOutputs: false
	};
}

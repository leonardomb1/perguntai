import { generateText, type LanguageModelUsage, type UIMessage } from 'ai';
import { modelContextWindow, resolveLanguageModel } from './models';

/**
 * Conversation compaction. The client owns the transcript and re-sends it on
 * every turn, so compaction is a MARKER message inside that transcript: the
 * user keeps seeing the full history, while the model receives only the
 * marker's summary plus the messages after it. Markers stack — a new
 * compaction summarizes the previous summary together with what followed it.
 */

export interface CompactionMarker {
	summary: string;
	at: number;
	model: string;
	/** Measured prompt size just before compacting, for the divider label. */
	contextBefore?: number;
}

/** Live context measurement carried on every assistant message. */
export interface ContextMeter {
	tokens: number;
	window: number;
	model: string;
}

export interface ChatMessageMetadata {
	compaction?: CompactionMarker;
	context?: ContextMeter;
}

function metadataOf(message: UIMessage): ChatMessageMetadata {
	return (message.metadata ?? {}) as ChatMessageMetadata;
}

function lastMarkerIndex(messages: UIMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) if (metadataOf(messages[i]).compaction) return i;
	return -1;
}

const summaryText = (summary: string) =>
	'<conversation_summary>\nThe earlier part of this conversation was compacted to save context. ' +
	'This summary replaces it; the user can still see the original messages.\n\n' +
	`${summary}\n</conversation_summary>`;

/** What the model actually receives: the latest summary + everything after it. */
export function applyCompaction(messages: UIMessage[]): UIMessage[] {
	const at = lastMarkerIndex(messages);
	if (at < 0) return messages;
	const marker = metadataOf(messages[at]).compaction!;
	return [
		{ id: `${messages[at].id}-summary`, role: 'user', parts: [{ type: 'text', text: summaryText(marker.summary) }] },
		...messages.slice(at + 1)
	];
}

/** Prompt size the model last reported for this (compacted) transcript, if any. */
export function lastMeasuredContext(messages: UIMessage[]): ContextMeter | null {
	const from = lastMarkerIndex(messages);
	for (let i = messages.length - 1; i > from; i--) {
		const context = metadataOf(messages[i]).context;
		if (messages[i].role === 'assistant' && context) return context;
	}
	return null;
}

/** Full prompt size of one step: cached and uncached input plus what it wrote. */
export function stepContextTokens(usage: LanguageModelUsage | undefined): number {
	if (!usage) return 0;
	const d = usage.inputTokenDetails;
	const parts = (d?.noCacheTokens ?? 0) + (d?.cacheReadTokens ?? 0) + (d?.cacheWriteTokens ?? 0);
	return Math.max(usage.inputTokens ?? 0, parts) + (usage.outputTokens ?? 0);
}

/** Provider rejections that mean "the transcript no longer fits". */
export function isContextOverflow(message: string): boolean {
	return /prompt is too long|context.{0,20}(length|window|limit)|maximum context|too many tokens/i.test(message);
}

export const CONTEXT_OVERFLOW_CODE = 'context_overflow';

const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max)}… [${text.length - max} chars omitted]` : text;

const asText = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value ?? null));

/**
 * Text-only rendering of the part of the conversation being compacted.
 * Attachments become one-line placeholders and tool payloads are clipped —
 * the transcript that overflowed the window has to fit a summarization call.
 */
function renderTranscript(messages: UIMessage[], maxChars: number): string {
	const at = lastMarkerIndex(messages);
	const previous = at >= 0 ? metadataOf(messages[at]).compaction!.summary : null;
	const blocks: string[] = [];
	for (const message of messages.slice(at + 1)) {
		const lines: string[] = [];
		for (const part of message.parts) {
			const p = part as Record<string, unknown> & { type: string };
			if (p.type === 'text' && typeof p.text === 'string') lines.push(p.text);
			else if (p.type === 'file') lines.push(`[attached file: ${asText(p.filename ?? p.mediaType)}]`);
			else if (p.type === 'dynamic-tool' || p.type.startsWith('tool-')) {
				const name = typeof p.toolName === 'string' ? p.toolName : p.type.slice(5);
				const output = 'output' in p ? ` → ${clip(asText(p.output), 3000)}` : '';
				lines.push(`[tool ${name}(${clip(asText(p.input), 800)})${output}]`);
			}
		}
		if (lines.length) blocks.push(`### ${message.role === 'user' ? 'User' : 'Assistant'}\n${lines.join('\n')}`);
	}
	// Oldest blocks go first when the budget is short: recent turns matter most.
	let body = blocks.join('\n\n');
	if (body.length > maxChars) body = `[earliest turns omitted]\n\n${body.slice(body.length - maxChars)}`;
	return previous ? `## Summary of the conversation before this point\n${previous}\n\n## Conversation since\n${body}` : body;
}

const SUMMARY_SYSTEM =
	'You compact a conversation between a user and a data-analysis assistant so it can continue in a fresh context. ' +
	'Write a dense summary in the SAME LANGUAGE the user writes in. Preserve everything needed to continue the work: ' +
	'the user’s goals and open requests, decisions and conclusions reached, exact names (tables, columns, files, ' +
	'documents, systems, people), key numbers and query logic that produced them, generated artifacts, the user’s stated ' +
	'preferences, and unresolved questions. Drop pleasantries, dead ends and raw data dumps. ' +
	'Use short headed sections and bullet points. Do not invent anything that is not in the transcript.';

export async function summarizeConversation(
	messages: UIMessage[],
	model: string
): Promise<{ summary: string; usage: LanguageModelUsage }> {
	// ~3 chars per token, leaving room for the system prompt and the summary.
	const maxChars = Math.floor(modelContextWindow(model) * 0.5 * 3);
	const result = await generateText({
		model: resolveLanguageModel(model),
		system: SUMMARY_SYSTEM,
		prompt: renderTranscript(messages, maxChars),
		maxOutputTokens: 8000
	});
	return { summary: result.text.trim(), usage: result.usage };
}

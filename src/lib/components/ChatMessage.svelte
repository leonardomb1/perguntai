<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import type { DynamicToolUIPart, ToolUIPart, UIMessage, UIMessagePart, UIDataTypes, UITools } from 'ai';
	import { getToolName, isDynamicToolUIPart, isToolUIPart } from 'ai';
	import Markdown from './Markdown.svelte';
	import ToolGroup from './ToolGroup.svelte';
	import AskUser from './AskUser.svelte';
	import Chart, { type ChartSpec } from './Chart.svelte';
	import Mermaid from './Mermaid.svelte';
	import Avatar from './Avatar.svelte';
	import Icon from './Icon.svelte';
	import { downloadExport, fetchExportBlob } from '$lib/download';
	import { autoOpenArtifact, openArtifact, type ArtifactSpec } from '$lib/artifact-panel.svelte';
	import { copyText } from '$lib/clipboard';

	let downloadError = $state<string | null>(null);
	async function handleDownload(spec: ExportSpec) {
		downloadError = await downloadExport(spec.fileId, spec.filename);
	}

	let {
		message,
		username,
		isLast = false,
		busy = false,
		onEdit,
		onRegenerate,
		onAsk,
		onChatInstead
	}: {
		message: UIMessage;
		username: string;
		isLast?: boolean;
		busy?: boolean;
		onEdit?: (messageId: string, text: string) => void;
		onRegenerate?: () => void;
		/** Resolve an askUser tool call with the user's chosen option. */
		onAsk?: (toolCallId: string, label: string) => void;
		/** Skip the option buttons — unlock the composer for a free-text answer. */
		onChatInstead?: () => void;
	} = $props();

	type Part = UIMessagePart<UIDataTypes, UITools>;
	type AnyToolPart = ToolUIPart | DynamicToolUIPart;
	type DiagramSpec = { title: string; mermaid: string };
	type ExportSpec = {
		fileId: string;
		filename: string;
		bytes: number;
		sheets?: { name: string; rows: number }[];
		format?: string;
	};
	type ReasoningPart = Extract<Part, { type: 'reasoning' }>;
	type StepPart = AnyToolPart | ReasoningPart;
	type AskSpec = {
		toolCallId: string;
		question: string;
		options: string[];
		answered: boolean;
		chosen?: string;
	};
	type Item =
		| { kind: 'part'; part: Part }
		| { kind: 'text'; text: string }
		| { kind: 'chart'; spec: ChartSpec }
		| { kind: 'diagram'; spec: DiagramSpec }
		| { kind: 'export'; spec: ExportSpec }
		| { kind: 'ask'; spec: AskSpec }
		| { kind: 'tools'; parts: StepPart[] };

	// Claude-style: a document produced during the live turn opens the side
	// panel by itself; history rerenders never re-open (autoOpen dedupes by key).
	$effect(() => {
		if (!busy || !isLast) return;
		for (const item of items) {
			if (item.kind === 'export') {
				const spec = exportArtifact(item.spec);
				if (spec) autoOpenArtifact(spec);
			}
		}
	});

	function toolOutput<T extends { error?: string }>(part: AnyToolPart): T | null {
		const p = part as { state?: string; output?: T };
		if (p.state !== 'output-available' || !p.output || p.output.error) return null;
		return p.output;
	}

	const VIEWABLE_TEXT = new Set(['md', 'markdown', 'txt', 'csv', 'json', 'html']);

	function exportArtifact(spec: ExportSpec): ArtifactSpec | null {
		const ext = (spec.format ?? spec.filename.split('.').pop() ?? '').toLowerCase();
		const kind: ArtifactSpec['kind'] | null =
			ext === 'pdf'
				? 'pdf'
				: ext === 'html'
					? 'html'
					: ext === 'md' || ext === 'markdown'
						? 'markdown'
						: VIEWABLE_TEXT.has(ext)
							? 'text'
							: null;
		if (!kind) return null;
		return {
			key: `export:${spec.fileId}`,
			title: spec.filename.replace(/\.[^.]+$/, ''),
			badge: ext.toUpperCase() || 'DOC',
			kind,
			load: async () => {
				const { blob, error } = await fetchExportBlob(spec.fileId, spec.filename);
				if (!blob) return { error: error ?? undefined };
				return kind === 'pdf' ? { objectUrl: URL.createObjectURL(blob) } : { text: await blob.text() };
			},
			download: () => downloadExport(spec.fileId, spec.filename)
		};
	}

	// Group each consecutive run of tool calls AND the reasoning between them
	// into ONE collapsible steps block (Claude-style) — interleaved reasoning
	// used to split runs into a wall of alternating cards. Charts/diagrams/
	// exports still pop out as content; standalone reasoning (no adjacent
	// tools) keeps its own rendering. step-start parts never break a run.
	const items = $derived.by(() => {
		const out: Item[] = [];
		let run: StepPart[] = [];
		const flush = () => {
			// A run holds tool calls and/or reasoning. Both — including a
			// reasoning-only run (pure thinking, no tools) — render through the
			// same collapsible steps timeline (ToolGroup), so thinking gets the
			// quiet "Raciocinando" header instead of the old <details> block.
			if (run.length === 0) return;
			out.push({ kind: 'tools', parts: run });
			run = [];
		};
		for (const part of message.parts) {
			if (part.type === 'step-start') continue;
			if (part.type === 'reasoning' && !part.text.trim()) continue;
			if (isToolUIPart(part) || isDynamicToolUIPart(part)) {
				const name = getToolName(part);
				if (name === 'askUser') {
					// Pops out of the tool timeline into an interactive choice card as
					// soon as the input is available (question + options), and shows the
					// picked option once resolved. Fall back to rawInput: if the call was
					// marked errored the SDK moves the value there and clears `input`.
					type AskInput = { question?: string; options?: string[] };
					let input = part.input as AskInput | undefined;
					const rawInput = (part as { rawInput?: unknown }).rawInput;
					if (!input?.question && typeof rawInput === 'string') {
						try {
							input = JSON.parse(rawInput) as AskInput;
						} catch {
							/* keep input */
						}
					}
					if (input?.question && Array.isArray(input.options)) {
						flush();
						const output = part.state === 'output-available'
							? (part.output as { selected?: string } | undefined)
							: undefined;
						out.push({
							kind: 'ask',
							spec: {
								toolCallId: part.toolCallId,
								question: input.question,
								options: input.options,
								answered: part.state === 'output-available',
								chosen: output?.selected
							}
						});
						continue;
					}
				} else if (name === 'renderChart') {
					const spec = toolOutput<ChartSpec & { error?: string }>(part);
					if (spec) {
						flush();
						out.push({ kind: 'chart', spec });
						continue;
					}
				} else if (name === 'renderDiagram') {
					const spec = toolOutput<DiagramSpec & { error?: string }>(part);
					if (spec) {
						flush();
						out.push({ kind: 'diagram', spec });
						continue;
					}
				} else if (
					name === 'generateExcel' ||
					name === 'generateDocument' ||
					name === 'generatePdf' ||
					name === 'sandboxPresentFile'
				) {
					const spec = toolOutput<ExportSpec & { error?: string }>(part);
					if (spec?.fileId) {
						flush();
						out.push({ kind: 'export', spec });
						continue;
					}
				}
				run.push(part);
			} else if (part.type === 'reasoning') {
				run.push(part as ReasoningPart);
			} else if (part.type === 'text') {
				// web_search splits one answer into many text parts at citation
				// boundaries (sentences broken mid-way). Concatenate CONSECUTIVE
				// text parts into ONE markdown render so paragraphs/lists aren't
				// shattered. A tool/chart in between flushes, keeping genuinely
				// separate prose blocks apart.
				flush();
				const lastItem = out[out.length - 1];
				if (lastItem?.kind === 'text') lastItem.text += part.text;
				else out.push({ kind: 'text', text: part.text });
			} else {
				flush();
				out.push({ kind: 'part', part });
			}
		}
		flush();
		return out;
	});

	const messageText = $derived(
		message.parts
			.filter((p) => p.type === 'text')
			.map((p) => (p as { text: string }).text)
			.join('\n\n')
	);

	// --- copy with feedback ---
	let copied = $state(false);
	async function copy() {
		if (await copyText(messageText)) {
			copied = true;
			setTimeout(() => (copied = false), 1500);
		}
	}

	// --- inline editing of user messages ---
	let editing = $state(false);
	let draft = $state('');
	let editArea = $state<HTMLTextAreaElement | null>(null);

	function startEdit() {
		draft = messageText;
		editing = true;
		queueMicrotask(() => {
			editArea?.focus();
			if (editArea) {
				editArea.style.height = 'auto';
				editArea.style.height = Math.min(editArea.scrollHeight, 240) + 'px';
			}
		});
	}

	function submitEdit() {
		const text = draft.trim();
		editing = false;
		if (text && text !== messageText) onEdit?.(message.id, text);
	}

	function handleEditKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') editing = false;
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			submitEdit();
		}
	}

	const actionButton =
		'rounded-md p-1.5 text-neutral-400 transition hover:bg-[#f0eee6] hover:text-neutral-700';

	// A scheduled run's opening prompt renders as a quiet "Tarefa agendada
	// executada" marker (Claude-style) instead of a giant user bubble — the
	// standing instructions expand on demand.
	const SCHED_PREFIX = '[Scheduled run]';
	const scheduledPrompt = $derived(
		message.role === 'user' && messageText.startsWith(SCHED_PREFIX) ? messageText : null
	);
	let schedOpen = $state(false);
</script>

{#if scheduledPrompt !== null}
	<div>
		<button
			onclick={() => (schedOpen = !schedOpen)}
			class="flex w-full items-center gap-2.5 rounded-xl border border-[#e3e0d5] bg-white px-4 py-3 text-left transition hover:bg-[#faf9f5]"
		>
			<Icon name="clock" size={15} class="shrink-0 text-neutral-400" />
			<span class="min-w-0 flex-1 truncate text-sm text-neutral-700">{m.sched_run_executed()}</span>
			<Icon
				name="chevron-down"
				size={13}
				class="shrink-0 text-neutral-300 transition-transform {schedOpen ? '' : '-rotate-90'}"
			/>
		</button>
		{#if schedOpen}
			<div class="mt-1.5 rounded-xl border border-[#e9e6dd] bg-[#faf9f5] px-4 py-3">
				<p class="text-sm leading-relaxed whitespace-pre-wrap text-neutral-600">
					{scheduledPrompt.slice(SCHED_PREFIX.length).trim()}
				</p>
			</div>
		{/if}
	</div>
{:else if message.role === 'user'}
	<div class="group flex flex-col items-end">
		<div class="flex w-full items-start justify-end gap-3">
			{#if editing}
				<div class="w-full max-w-[75%]">
					<textarea
						bind:this={editArea}
						bind:value={draft}
						onkeydown={handleEditKeydown}
						rows="2"
						class="w-full resize-none rounded-2xl border border-[#d97757]/50 bg-white px-4 py-2.5 text-[15px] text-neutral-800 focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
					></textarea>
					<div class="mt-1.5 flex justify-end gap-2">
						<button
							onclick={() => (editing = false)}
							class="rounded-lg border border-[#e3e0d5] bg-white px-3 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
						>
							{m.cancel()}
						</button>
						<button
							onclick={submitEdit}
							class="rounded-lg bg-[#d97757] px-3 py-1 text-xs font-medium text-white hover:bg-[#bd5d3a]"
						>
							{m.save_resend()}
						</button>
					</div>
				</div>
			{:else}
				<div
					class="max-w-[75%] rounded-2xl rounded-tr-sm border border-[#e3e0d5] bg-[#f0eee6] px-4 py-2.5 text-neutral-800"
				>
					{#each message.parts as part, i (i)}
						{#if part.type === 'file'}
							{#if part.mediaType?.startsWith('image/')}
								<img
									src={part.url}
									alt={part.filename ?? ''}
									class="mb-2 max-h-64 rounded-xl border border-[#e3e0d5]"
								/>
							{:else}
								<div
									class="mb-2 flex w-fit items-center gap-2 rounded-xl border border-[#e3e0d5] bg-white px-3 py-2"
								>
									<Icon name="file" size={15} class="shrink-0 text-[#bd5d3a]" />
									<span class="text-sm">{part.filename ?? 'documento.pdf'}</span>
								</div>
							{/if}
						{:else if part.type === 'text'}
							<p class="break-words whitespace-pre-wrap">{part.text}</p>
						{/if}
					{/each}
				</div>
			{/if}
			<Avatar {username} size={28} />
		</div>

		{#if !editing}
			<div
				class="mt-1 mr-10 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
			>
				{#if onEdit && !busy}
					<button onclick={startEdit} class={actionButton} title={m.edit_message()} aria-label={m.edit_message()}>
						<Icon name="square-pen" size={14} />
					</button>
				{/if}
				<button onclick={copy} class={actionButton} title={m.copy()} aria-label={m.copy()}>
					<Icon name={copied ? 'check' : 'copy'} size={14} />
				</button>
			</div>
		{/if}
	</div>
{:else}
	<div class="group flex flex-col gap-3">
		{#each items as item, i (i)}
			{#if item.kind === 'chart'}
				<Chart spec={item.spec} />
			{:else if item.kind === 'diagram'}
				<Mermaid code={item.spec.mermaid} title={item.spec.title} />
			{:else if item.kind === 'export'}
				{@const viewer = exportArtifact(item.spec)}
				<div
					class="flex w-fit max-w-full items-center gap-3 rounded-xl border border-[#e3e0d5] bg-white px-4 py-3"
				>
					<span class="grid size-10 shrink-0 place-items-center rounded-lg bg-[#1baf7a]/10 text-[#0d8a5f]">
						<Icon name="file" size={20} />
					</span>
					<span class="min-w-0">
						<span class="block truncate text-sm font-medium text-neutral-800">
							{item.spec.filename}
						</span>
						<span class="block text-xs text-neutral-500">
							{#if item.spec.sheets?.length}
								{item.spec.sheets.map((s) => `${s.name} (${m.rows_count({ count: s.rows.toLocaleString() })})`).join(' · ')} ·
							{:else if item.spec.format}
								{item.spec.format.toUpperCase()} ·
							{/if}
							{(item.spec.bytes / 1024).toFixed(item.spec.bytes < 10240 ? 1 : 0)} KB
						</span>
						{#if downloadError}
							<span class="block text-xs text-red-600">{downloadError}</span>
						{/if}
					</span>
					{#if viewer}
						<button
							onclick={() => openArtifact(viewer)}
							class="ml-2 flex shrink-0 items-center gap-1.5 rounded-lg border border-[#e3e0d5] px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-[#f0efea]"
						>
							<Icon name="eye" size={13} />
							{m.artifact_view()}
						</button>
					{/if}
					<button
						onclick={() => handleDownload(item.spec as ExportSpec)}
						class="flex shrink-0 items-center gap-1.5 rounded-lg bg-[#d97757] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[#bd5d3a]"
						class:ml-2={!viewer}
					>
						<Icon name="download" size={13} />
						{m.download()}
					</button>
				</div>
			{:else if item.kind === 'ask'}
				<AskUser
					question={item.spec.question}
					options={item.spec.options}
					answered={item.spec.answered}
					chosen={item.spec.chosen}
					onAnswer={(label) => onAsk?.(item.spec.toolCallId, label)}
					{onChatInstead}
				/>
			{:else if item.kind === 'tools'}
				<ToolGroup parts={item.parts} live={busy && isLast && i === items.length - 1} />
			{:else if item.kind === 'text'}
				<Markdown content={item.text} />
			{:else if item.part.type === 'text'}
				<Markdown content={item.part.text} />
			{/if}
		{/each}

		{#if !busy && messageText}
			<div
				class="-mt-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
			>
				<button onclick={copy} class={actionButton} title={m.copy_response()} aria-label={m.copy_response()}>
					<Icon name={copied ? 'check' : 'copy'} size={14} />
				</button>
				{#if isLast && onRegenerate}
					<button
						onclick={onRegenerate}
						class={actionButton}
						title={m.regenerate_response()}
						aria-label={m.regenerate_response()}
					>
						<Icon name="refresh" size={14} />
					</button>
				{/if}
			</div>
		{/if}
	</div>
{/if}

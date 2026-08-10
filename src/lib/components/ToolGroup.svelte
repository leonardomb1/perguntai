<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import type { DynamicToolUIPart, ToolUIPart } from 'ai';
	import { getToolName } from 'ai';
	import Icon from './Icon.svelte';
	import ToolCall from './ToolCall.svelte';
	import { toolDisplay } from '$lib/tool-display';

	/**
	 * One agentic run: the tool calls AND the reasoning between them, folded
	 * into a single quiet, collapsible timeline (Claude-style). While the run
	 * is live the header shimmers with the current activity; once done it
	 * collapses to a one-line summary.
	 */
	type ReasoningPart = { type: 'reasoning'; text: string };
	type StepPart = ToolUIPart | DynamicToolUIPart | ReasoningPart;

	let { parts, live = false }: { parts: StepPart[]; live?: boolean } = $props();

	let open = $state(false);

	const isTool = (p: StepPart): p is ToolUIPart | DynamicToolUIPart => p.type !== 'reasoning';

	const toolParts = $derived(parts.filter(isTool));
	const failedCount = $derived(toolParts.filter((p) => p.state === 'output-error').length);

	// The run is "working" while its last step is an unfinished tool, or while
	// the message is still streaming into this block (reasoning included).
	const runningTool = $derived(
		toolParts.find((p) => p.state === 'input-streaming' || p.state === 'input-available')
	);
	const working = $derived(Boolean(runningTool) || (live && parts.at(-1)?.type === 'reasoning'));

	const activity = $derived.by(() => {
		if (runningTool) return toolDisplay(getToolName(runningTool)).label;
		return m.steps_thinking();
	});

	const summary = $derived.by(() => {
		const labels = [...new Set(toolParts.map((p) => toolDisplay(getToolName(p)).label))];
		return labels.slice(0, 3).join(', ') + (labels.length > 3 ? '…' : '');
	});

	const count = $derived(parts.length);
</script>

<div class="text-sm">
	<button
		onclick={() => (open = !open)}
		class="flex max-w-full items-center gap-1.5 rounded-md py-0.5 pr-2 text-neutral-500 transition hover:text-neutral-700"
	>
		<Icon
			name="chevron-down"
			size={13}
			class="shrink-0 text-neutral-400 transition-transform {open ? '' : '-rotate-90'}"
		/>
		{#if working}
			<span class="shimmer truncate">{activity}…</span>
		{:else}
			<span class="truncate">{summary || m.steps_thinking()}</span>
			<span class="shrink-0 text-xs text-neutral-400">
				· {count === 1 ? m.steps_one() : m.steps_many({ count })}
			</span>
			{#if failedCount > 0}
				<span class="shrink-0 text-xs text-red-500">· {m.tool_failed()}</span>
			{/if}
		{/if}
	</button>

	{#if open}
		<div class="mt-1.5 ml-[5px] flex flex-col border-l-2 border-[#e8e5da] pl-3.5">
			{#each parts as part, i (i)}
				{#if part.type === 'reasoning'}
					<ToolCall reasoning={part.text} />
				{:else}
					<ToolCall {part} />
				{/if}
			{/each}
		</div>
	{/if}
</div>

<style>
	.shimmer {
		background: linear-gradient(90deg, #8f8d84 30%, #d3d0c4 50%, #8f8d84 70%);
		background-size: 200% 100%;
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
		animation: shimmer 2s linear infinite;
	}
	@keyframes shimmer {
		to {
			background-position: -200% 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.shimmer {
			animation: none;
			color: #8f8d84;
			background: none;
		}
	}
</style>

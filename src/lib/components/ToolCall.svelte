<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import type { DynamicToolUIPart, ToolUIPart } from 'ai';
	import { getToolName } from 'ai';
	import Icon from './Icon.svelte';
	import { toolDisplay } from '$lib/tool-display';

	/**
	 * One row of a steps timeline: either a tool call or a reasoning snippet.
	 * Quiet by default (icon + label), expandable for details. The detail body
	 * only exists in the DOM while expanded — big payloads (a 200-row
	 * queryDatabase result) must not weigh the page down or force layout.
	 */
	let {
		part,
		reasoning
	}: { part?: ToolUIPart | DynamicToolUIPart; reasoning?: string } = $props();

	let open = $state(false);

	const display = $derived(part ? toolDisplay(getToolName(part)) : null);
	const running = $derived(
		part ? part.state === 'input-streaming' || part.state === 'input-available' : false
	);
	const failed = $derived(part ? part.state === 'output-error' : false);

	// Bound what we pretty-print: huge outputs freeze layout, and stringify can
	// throw on circular values — a render throw kills the whole app.
	const MAX_JSON = 20_000;
	function pretty(value: unknown): string {
		try {
			const s = JSON.stringify(value, null, 2) ?? '';
			return s.length > MAX_JSON ? `${s.slice(0, MAX_JSON)}\n… (${m.tool_truncated()})` : s;
		} catch {
			return String(value);
		}
	}

	function hostnameOf(url: string): string {
		try {
			return new URL(url).hostname;
		} catch {
			return '';
		}
	}

	// Anthropic's server-side web search: render the query and the source links
	// instead of the raw output (whose encryptedContent blobs are huge).
	type WebSearchResult = { url: string; title: string | null };
	const webSearchResults = $derived.by<WebSearchResult[] | null>(() => {
		if (!part || getToolName(part) !== 'web_search' || part.state !== 'output-available')
			return null;
		const out = part.output;
		if (!Array.isArray(out)) return null;
		return (out as WebSearchResult[]).filter((r) => typeof r?.url === 'string');
	});
</script>

<div>
	<button
		onclick={() => (open = !open)}
		class="group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm transition hover:bg-white/80
			{failed ? 'text-red-600' : 'text-neutral-600'}"
	>
		{#if running}
			<span
				class="size-3.5 shrink-0 animate-spin rounded-full border-2 border-[#e3e0d5] border-t-[#d97757]"
				aria-hidden="true"
			></span>
		{:else if reasoning !== undefined}
			<Icon name="sparkle" size={14} class="shrink-0 text-neutral-400" />
		{:else if display}
			<Icon
				name={display.icon as 'wrench'}
				size={14}
				class="shrink-0 {failed ? 'text-red-400' : 'text-neutral-400'}"
			/>
		{/if}

		{#if reasoning !== undefined}
			<span class="min-w-0 flex-1 truncate font-serif text-neutral-500 italic">
				{m.reasoning()}
			</span>
		{:else if display}
			<span class="min-w-0 truncate" title={display.title}>{display.label}</span>
			{#if display.badge}
				<span class="shrink-0 text-[10px] font-medium tracking-wide text-neutral-400 uppercase">
					{display.badge}
				</span>
			{/if}
			{#if failed}
				<span class="shrink-0 text-xs">{m.tool_failed()}</span>
			{/if}
			<span class="min-w-0 flex-1"></span>
		{/if}

		<Icon
			name="chevron-down"
			size={12}
			class="shrink-0 text-neutral-300 opacity-0 transition-all group-hover:opacity-100 {open
				? 'opacity-100'
				: '-rotate-90'}"
		/>
	</button>

	{#if open}
		<div class="mt-0.5 mb-1.5 ml-7 space-y-2 rounded-lg border border-[#e3e0d5] bg-white p-2.5">
			{#if reasoning !== undefined}
				<p class="text-xs leading-relaxed whitespace-pre-wrap text-neutral-500">{reasoning}</p>
			{:else if part}
				{#if part.input !== undefined}
					<div>
						<div class="mb-1 text-xs font-medium tracking-wide text-neutral-400 uppercase">
							{m.tool_input()}
						</div>
						<pre class="overflow-x-auto rounded bg-[#faf9f5] p-2 text-xs">{pretty(part.input)}</pre>
					</div>
				{/if}
				{#if webSearchResults}
					<div>
						<div class="mb-1 text-xs font-medium tracking-wide text-neutral-400 uppercase">
							{m.web_sources()}
						</div>
						<ul class="space-y-1">
							{#each webSearchResults as result, i (i)}
								<li class="truncate text-xs">
									<a
										href={result.url}
										target="_blank"
										rel="noopener noreferrer"
										class="text-[#bd5d3a] hover:underline"
									>
										{result.title || result.url}
									</a>
									{#if hostnameOf(result.url)}
										<span class="text-neutral-400"> — {hostnameOf(result.url)}</span>
									{/if}
								</li>
							{/each}
						</ul>
					</div>
				{:else if part.state === 'output-available'}
					<div>
						<div class="mb-1 text-xs font-medium tracking-wide text-neutral-400 uppercase">
							{m.tool_output()}
						</div>
						<pre class="overflow-x-auto rounded bg-[#faf9f5] p-2 text-xs">{pretty(part.output)}</pre>
					</div>
				{:else if part.state === 'output-error'}
					<p class="text-xs text-red-600">{part.errorText}</p>
				{/if}
			{/if}
		</div>
	{/if}
</div>

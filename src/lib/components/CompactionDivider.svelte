<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import Markdown from './Markdown.svelte';
	import Icon from './Icon.svelte';
	import { formatTokens } from '$lib/admin';

	let { summary, contextBefore }: { summary: string; contextBefore?: number } = $props();

	let open = $state(false);
</script>

<div class="flex flex-col gap-3">
	<div class="flex items-center gap-3 text-xs text-neutral-400">
		<span class="h-px flex-1 bg-edge"></span>
		<button
			onclick={() => (open = !open)}
			class="flex items-center gap-1.5 rounded-full px-2 py-0.5 transition hover:text-neutral-600"
			aria-expanded={open}
		>
			<Icon name="chevron-down" size={12} class="transition {open ? 'rotate-180' : ''}" />
			{contextBefore
				? m.compaction_divider_tokens({ tokens: formatTokens(contextBefore) })
				: m.compaction_divider()}
		</button>
		<span class="h-px flex-1 bg-edge"></span>
	</div>
	{#if open}
		<div class="rounded-xl border border-edge bg-surface px-5 py-4 text-sm">
			<p class="mb-2 text-xs text-neutral-500">{m.compaction_summary_hint()}</p>
			<Markdown content={summary} />
		</div>
	{/if}
</div>

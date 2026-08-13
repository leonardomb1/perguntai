<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import Icon from './Icon.svelte';

	let {
		values = $bindable(),
		placeholder = '',
		suggestions = []
	}: { values: string[]; placeholder?: string; suggestions?: string[] } = $props();

	let draft = $state('');

	function add(v: string) {
		const t = v.trim();
		if (t && !values.includes(t)) values = [...values, t];
	}
	function commitDraft() {
		add(draft);
		draft = '';
	}
	function remove(v: string) {
		values = values.filter((x) => x !== v);
	}

	const openSuggestions = $derived(suggestions.filter((s) => !values.includes(s)).slice(0, 12));
</script>

<div class="rounded-lg border border-[#e3e0d5] bg-white px-2 py-1.5">
	<div class="flex flex-wrap items-center gap-1.5">
		{#each values as v (v)}
			<span
				class="flex max-w-full items-center gap-1 rounded-md bg-[#d97757]/12 py-0.5 pr-1 pl-2 text-xs font-medium break-all text-[#bd5d3a]"
			>
				{v}
				<button
					onclick={() => remove(v)}
					class="grid size-4 place-items-center rounded transition hover:bg-[#d97757]/20"
					aria-label={m.org_dept_chip_remove()}
				>
					<Icon name="x" size={11} />
				</button>
			</span>
		{/each}
		<input
			bind:value={draft}
			{placeholder}
			onkeydown={(e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					commitDraft();
				} else if (e.key === 'Backspace' && !draft && values.length) {
					remove(values[values.length - 1]);
				}
			}}
			onblur={commitDraft}
			class="min-w-[7rem] flex-1 bg-transparent px-1 py-1 text-sm outline-none"
		/>
	</div>
</div>

{#if openSuggestions.length}
	<div class="mt-1.5 flex flex-wrap items-center gap-1.5">
		<span class="text-[11px] text-neutral-400">{m.org_dept_suggestions()}</span>
		{#each openSuggestions as s (s)}
			<button
				onclick={() => add(s)}
				class="flex items-center gap-1 rounded-md border border-dashed border-[#d8d4c6] px-1.5 py-0.5 text-[11px] text-neutral-500 transition hover:border-[#d97757]/50 hover:text-[#bd5d3a]"
			>
				<Icon name="plus" size={10} />
				{s}
			</button>
		{/each}
	</div>
{/if}

<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import Icon from './Icon.svelte';

	let {
		question,
		options,
		answered = false,
		chosen,
		onAnswer,
		onChatInstead
	}: {
		question: string;
		options: string[];
		answered?: boolean;
		chosen?: string;
		onAnswer: (label: string) => void;
		/** Unlock the composer so the user can answer in free text instead. */
		onChatInstead?: () => void;
	} = $props();
</script>

<div class="max-w-lg rounded-2xl border border-[#e3e0d5] bg-white p-4 shadow-sm">
	<div class="mb-3 flex items-start gap-2">
		<span class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-[#d97757]/12 text-[#bd5d3a]">
			<Icon name="sparkle" size={13} />
		</span>
		<span class="text-sm font-medium text-neutral-800">{question}</span>
	</div>
	<div class="flex flex-col gap-1.5">
		{#each options as o (o)}
			{@const isChosen = answered && chosen === o}
			<button
				type="button"
				disabled={answered}
				onclick={() => onAnswer(o)}
				class="flex items-center gap-2 rounded-xl border px-3 py-2 text-left transition
					{isChosen
					? 'border-[#d97757] bg-[#d97757]/8'
					: answered
						? 'border-[#efede3] opacity-50'
						: 'border-[#e3e0d5] hover:border-[#d97757]/50 hover:bg-[#faf9f5]'}"
			>
				<span class="min-w-0 flex-1 text-sm font-medium text-neutral-800">{o}</span>
				{#if isChosen}
					<Icon name="check" size={15} class="shrink-0 text-[#bd5d3a]" />
				{/if}
			</button>
		{/each}
	</div>
	{#if !answered && onChatInstead}
		<button
			type="button"
			onclick={onChatInstead}
			class="mt-2 flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-neutral-500 transition hover:bg-[#f0eee6] hover:text-neutral-700"
		>
			<Icon name="message-circle" size={13} />
			{m.ask_chat_instead()}
		</button>
	{:else if answered && !chosen}
		<div class="mt-2 flex items-center gap-1.5 px-2 text-xs text-neutral-400">
			<Icon name="message-circle" size={13} />
			{m.ask_answered_in_chat()}
		</div>
	{/if}
</div>

<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';

	/**
	 * One consistent token control for every connector card. A stored token is
	 * SHOWN as a masked value (the server never sends the real one), with
	 * explicit actions: Substituir swaps to an empty input, Remover marks it
	 * for removal on save (undoable until then).
	 *
	 * `value` is the pending replacement ('' = keep); `removeFlag` marks a
	 * pending removal. Both are the parent's save/dirty inputs, unchanged.
	 */
	let {
		tokenSet,
		value = $bindable(),
		removeFlag = $bindable()
	}: { tokenSet: boolean; value: string; removeFlag: boolean } = $props();

	let editing = $state(false);

	function startReplace() {
		removeFlag = false;
		editing = true;
	}
	function cancelReplace() {
		editing = false;
		value = '';
	}
	function markRemove() {
		value = '';
		editing = false;
		removeFlag = true;
	}
</script>

{#if removeFlag}
	<div
		class="mt-2.5 flex items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5"
	>
		<span class="text-xs text-red-700">{m.settings_mcp_token_pending()}</span>
		<button
			onclick={() => (removeFlag = false)}
			class="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-red-700 transition hover:bg-red-100"
		>
			{m.settings_mcp_token_undo()}
		</button>
	</div>
{:else if tokenSet && !editing}
	<div class="mt-2.5 flex items-center gap-2">
		<input
			value="••••••••••••••••"
			disabled
			class="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 font-mono text-xs text-neutral-500"
		/>
		<button
			onclick={startReplace}
			class="shrink-0 rounded-lg border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition hover:border-[#d97757]/50 hover:text-[#bd5d3a]"
		>
			{m.settings_mcp_token_replace()}
		</button>
		<button
			onclick={markRemove}
			class="shrink-0 rounded-lg px-2 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50"
		>
			{m.settings_mcp_token_remove()}
		</button>
	</div>
{:else}
	<div class="mt-2.5 flex items-center gap-2">
		<input
			bind:value
			type="password"
			maxlength="200"
			autocomplete="off"
			placeholder={m.settings_mcp_token_placeholder()}
			class="min-w-0 flex-1 rounded-lg border border-neutral-300 px-2.5 py-1.5 font-mono text-xs transition placeholder:font-sans placeholder:text-neutral-400 focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
		/>
		{#if tokenSet}
			<button
				onclick={cancelReplace}
				class="shrink-0 rounded-lg px-2 py-1.5 text-xs font-medium text-neutral-500 transition hover:bg-neutral-100"
			>
				{m.settings_mcp_token_cancel()}
			</button>
		{/if}
	</div>
{/if}

<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import Icon from './Icon.svelte';
	import { newId } from '$lib/id';
	import type { OrgKnowledgeEntry } from '$lib/admin';

	let { entries = $bindable() }: { entries: OrgKnowledgeEntry[] } = $props();

	function addEntry() {
		entries = [...entries, { id: newId(), title: '', body: '', enabled: true }];
	}
	function removeEntry(id: string) {
		entries = entries.filter((e) => e.id !== id);
	}
</script>

<div class="space-y-3">
	{#each entries as entry, i (entry.id)}
		<div class="rounded-xl border border-edge bg-surface p-3.5 transition {entry.enabled ? '' : 'opacity-60'}">
			<div class="flex items-center gap-2">
				<input
					bind:value={entry.title}
					maxlength="120"
					placeholder={m.org_kb_entry_title_placeholder()}
					class="min-w-0 flex-1 rounded-lg border border-transparent bg-canvas px-3 py-1.5 text-sm font-medium transition focus:border-accent focus:bg-surface focus:ring-2 focus:ring-accent/15 focus:outline-none"
				/>
				<button
					onclick={() => (entries[i].enabled = !entries[i].enabled)}
					role="switch"
					aria-checked={entry.enabled}
					title={entry.enabled ? m.org_kb_enabled() : m.org_kb_disabled()}
					class="relative h-5 w-9 shrink-0 rounded-full transition {entry.enabled ? 'bg-accent' : 'bg-neutral-300'}"
				>
					<span class="absolute top-0.5 size-4 rounded-full bg-surface transition-all {entry.enabled ? 'left-4' : 'left-0.5'}"></span>
				</button>
				<button
					onclick={() => removeEntry(entry.id)}
					class="grid size-8 shrink-0 place-items-center rounded-lg text-neutral-400 transition hover:bg-red-50 hover:text-red-600"
					title={m.org_kb_remove()}
					aria-label={m.org_kb_remove()}
				>
					<Icon name="trash" size={14} />
				</button>
			</div>
			<textarea
				bind:value={entry.body}
				maxlength="4000"
				rows="3"
				placeholder={m.org_kb_entry_body_placeholder()}
				class="mt-2 w-full resize-y rounded-lg border border-edge bg-surface px-3 py-2 text-sm leading-relaxed transition focus:border-accent focus:ring-2 focus:ring-accent/15 focus:outline-none"
			></textarea>
		</div>
	{/each}

	<button
		onclick={addEntry}
		class="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-edge px-3 py-2.5 text-sm font-medium text-neutral-500 transition hover:border-accent/50 hover:bg-accent/5 hover:text-accent-strong"
	>
		<Icon name="plus" size={15} />
		{m.org_kb_add()}
	</button>
</div>

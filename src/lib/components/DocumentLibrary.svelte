<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import Icon from './Icon.svelte';
	import { listOrgDocuments, uploadOrgDocument, removeOrgDocument, type SharedDoc } from '$lib/admin';

	// A shared document library, addressed by scope ('org' | departmentId). Docs
	// here are retrievable by everyone in the scope via the assistant.
	let { scope }: { scope: string } = $props();

	let docs = $state<SharedDoc[]>([]);
	let loaded = $state(false);
	let description = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);

	$effect(() => {
		// Reload when the scope changes (e.g. switching departments).
		const s = scope;
		loaded = false;
		listOrgDocuments(s).then((list) => {
			if (scope === s) {
				docs = list;
				loaded = true;
			}
		});
	});

	async function onPick(event: Event) {
		const file = (event.target as HTMLInputElement).files?.[0];
		if (fileInput) fileInput.value = '';
		if (!file) return;
		busy = true;
		error = null;
		const result = await uploadOrgDocument(scope, file, description);
		busy = false;
		if (result.ok) {
			docs = [...docs, result.doc];
			description = '';
		} else {
			error = result.error;
		}
	}

	async function remove(id: string) {
		if (await removeOrgDocument(scope, id)) docs = docs.filter((d) => d.id !== id);
	}
</script>

<div class="space-y-2">
	{#if docs.length}
		<div class="space-y-1.5">
			{#each docs as doc (doc.id)}
				<div class="flex items-start gap-2 rounded-lg border border-[#e9e6dd] bg-[#faf9f5] px-3 py-2">
					<Icon name="file" size={14} class="mt-0.5 shrink-0 text-[#bd5d3a]" />
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm font-medium text-neutral-800">{doc.name}</span>
						{#if doc.summary}
							<span class="block truncate text-xs text-neutral-500">{doc.summary}</span>
						{/if}
					</span>
					<button
						onclick={() => remove(doc.id)}
						class="shrink-0 text-neutral-300 transition hover:text-red-600"
						aria-label={m.org_docs_remove()}
						title={m.org_docs_remove()}
					>
						<Icon name="x" size={14} />
					</button>
				</div>
			{/each}
		</div>
	{:else if loaded}
		<p class="text-xs text-neutral-400">{m.org_docs_empty()}</p>
	{/if}

	<div class="flex items-center gap-2">
		<input
			bind:value={description}
			maxlength="200"
			placeholder={m.org_docs_desc_placeholder()}
			class="min-w-0 flex-1 rounded-lg border border-[#e3e0d5] bg-white px-3 py-1.5 text-xs transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
		/>
		<input
			bind:this={fileInput}
			type="file"
			accept=".txt,.md,.markdown,.json,.sql,.log,.pdf,.csv,.xlsx,.xls"
			class="hidden"
			onchange={onPick}
		/>
		<button
			onclick={() => fileInput?.click()}
			disabled={busy}
			class="flex shrink-0 items-center gap-1.5 rounded-lg border border-dashed border-[#d8d4c6] px-3 py-1.5 text-xs font-medium text-neutral-500 transition hover:border-[#d97757]/50 hover:bg-[#d97757]/5 hover:text-[#bd5d3a] disabled:opacity-50"
		>
			<Icon name={busy ? 'refresh' : 'plus'} size={14} class={busy ? 'animate-spin' : ''} />
			{m.org_docs_add()}
		</button>
	</div>

	{#if error}
		<p class="rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-700">{error}</p>
	{/if}
	<p class="text-[11px] text-neutral-400">{m.org_docs_visibility_note()}</p>
</div>

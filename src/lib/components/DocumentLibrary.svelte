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
				<div class="flex items-start gap-2 rounded-lg border border-edge bg-canvas px-3 py-2">
					<Icon name="file" size={14} class="mt-0.5 shrink-0 text-accent-strong" />
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

	<!-- Wraps on narrow screens so the description input keeps a usable width. -->
	<div class="flex flex-wrap items-center gap-2">
		<input
			bind:value={description}
			maxlength="200"
			placeholder={m.org_docs_desc_placeholder()}
			class="w-full rounded-lg border border-edge bg-surface px-3 py-1.5 text-xs transition focus:border-accent focus:ring-2 focus:ring-accent/15 focus:outline-none sm:w-auto sm:min-w-0 sm:flex-1"
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
			class="flex shrink-0 items-center gap-1.5 rounded-lg border border-dashed border-edge px-3 py-1.5 text-xs font-medium text-neutral-500 transition hover:border-accent/50 hover:bg-accent/5 hover:text-accent-strong disabled:opacity-50"
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

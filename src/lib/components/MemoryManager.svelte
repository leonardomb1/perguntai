<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import Icon from './Icon.svelte';
	import Markdown from './Markdown.svelte';
	import {
		listMemories,
		saveMemory,
		removeMemory,
		clearMemories,
		type UserMemory
	} from '$lib/memory';

	// Topic-based memory (like Claude's): a list of topics that drill into a
	// title / summary / markdown-details view, editable and deletable.
	let memories = $state<UserMemory[]>([]);
	let loaded = $state(false);
	let openId = $state<string | null>(null); // null = list; '__new__' = new draft
	let editing = $state(false);
	let draft = $state({ title: '', summary: '', details: '' });
	let busy = $state(false);

	listMemories().then((list) => {
		memories = list;
		loaded = true;
	});

	const current = $derived(
		openId && openId !== '__new__' ? (memories.find((mem) => mem.id === openId) ?? null) : null
	);

	function openDetail(mem: UserMemory) {
		openId = mem.id;
		editing = false;
	}
	function openNew() {
		openId = '__new__';
		editing = true;
		draft = { title: '', summary: '', details: '' };
	}
	function startEdit() {
		if (!current) return;
		draft = { title: current.title, summary: current.summary, details: current.details };
		editing = true;
	}
	function cancelEdit() {
		if (openId === '__new__') openId = null;
		editing = false;
	}
	function back() {
		openId = null;
		editing = false;
	}

	async function saveDraft() {
		if (busy) return;
		const payload = {
			title: draft.title.trim(),
			summary: draft.summary.trim(),
			details: draft.details.trim()
		};
		if (!payload.title && !payload.summary && !payload.details) return;
		busy = true;
		const saved = await saveMemory({
			...(openId && openId !== '__new__' ? { id: openId } : {}),
			...payload
		});
		busy = false;
		if (saved) {
			const idx = memories.findIndex((mem) => mem.id === saved.id);
			if (idx >= 0) memories[idx] = saved;
			else memories = [...memories, saved];
			openId = saved.id;
			editing = false;
		}
	}

	async function deleteCurrent() {
		if (!current || busy) return;
		const id = current.id;
		busy = true;
		const ok = await removeMemory(id);
		busy = false;
		if (ok) {
			memories = memories.filter((mem) => mem.id !== id);
			back();
		}
	}

	async function clearAll() {
		if (busy || !memories.length || !confirm(m.settings_memory_clear_confirm())) return;
		busy = true;
		const ok = await clearMemories();
		busy = false;
		if (ok) {
			memories = [];
			back();
		}
	}
</script>

{#if openId === null}
	<!-- LIST -->
	<div class="mb-2 flex items-center justify-between">
		<h3 class="text-sm font-semibold text-neutral-800">{m.settings_memory_stored()}</h3>
		{#if memories.length}
			<button onclick={clearAll} class="text-xs text-red-600 transition hover:underline">
				{m.settings_memory_clear()}
			</button>
		{/if}
	</div>

	{#if !loaded}
		<div class="grid place-items-center py-8">
			<span class="size-6 animate-spin rounded-full border-[3px] border-[#e3e0d5] border-t-[#d97757]"></span>
		</div>
	{:else if memories.length === 0}
		<p class="rounded-xl border border-dashed border-[#e3e0d5] px-4 py-6 text-center text-xs text-neutral-400">
			{m.settings_memory_empty()}
		</p>
	{:else}
		<div class="space-y-1.5">
			{#each memories as mem (mem.id)}
				<button
					onclick={() => openDetail(mem)}
					class="flex w-full items-center gap-2.5 rounded-lg border border-[#e9e6dd] bg-[#faf9f5] px-3 py-2.5 text-left transition hover:border-[#d97757]/40 hover:bg-[#d97757]/5"
				>
					<Icon name="sparkle" size={14} class="shrink-0 text-[#bd5d3a]" />
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm font-medium text-neutral-800">
							{mem.title || m.settings_memory_untitled()}
						</span>
						{#if mem.summary}
							<span class="block truncate text-xs text-neutral-500">{mem.summary}</span>
						{/if}
					</span>
					<Icon name="arrow-right" size={14} class="shrink-0 text-neutral-300" />
				</button>
			{/each}
		</div>
	{/if}

	<button
		onclick={openNew}
		class="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-[#d8d4c6] px-3 py-2.5 text-sm font-medium text-neutral-500 transition hover:border-[#d97757]/50 hover:bg-[#d97757]/5 hover:text-[#bd5d3a]"
	>
		<Icon name="plus" size={15} />
		{m.settings_memory_add()}
	</button>
{:else}
	<!-- DETAIL / EDIT -->
	<div class="mb-4 flex items-center gap-2">
		<button
			onclick={back}
			class="grid size-8 shrink-0 place-items-center rounded-lg text-neutral-500 transition hover:bg-[#f0eee6] hover:text-neutral-800"
			aria-label={m.settings_memory_back()}
			title={m.settings_memory_back()}
		>
			<Icon name="arrow-right" size={16} class="rotate-180" />
		</button>
		<h3 class="min-w-0 flex-1 truncate text-base font-semibold text-neutral-900">
			{#if editing}
				{openId === '__new__' ? m.settings_memory_new() : m.settings_memory_edit()}
			{:else}
				{current?.title || m.settings_memory_untitled()}
			{/if}
		</h3>
		{#if !editing && current}
			<button
				onclick={startEdit}
				class="shrink-0 rounded-lg border border-[#e3e0d5] px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-[#faf9f5]"
			>
				{m.settings_memory_edit()}
			</button>
			<button
				onclick={deleteCurrent}
				disabled={busy}
				class="shrink-0 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50"
			>
				{m.settings_memory_delete()}
			</button>
		{/if}
	</div>

	{#if editing}
		<div class="space-y-3">
			<input
				bind:value={draft.title}
				maxlength="120"
				placeholder={m.settings_memory_title_placeholder()}
				class="w-full rounded-lg border border-[#e3e0d5] bg-white px-3 py-2 text-sm font-medium transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
			/>
			<input
				bind:value={draft.summary}
				maxlength="300"
				placeholder={m.settings_memory_summary_placeholder()}
				class="w-full rounded-lg border border-[#e3e0d5] bg-white px-3 py-2 text-sm transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
			/>
			<textarea
				bind:value={draft.details}
				maxlength="6000"
				rows="10"
				placeholder={m.settings_memory_details_placeholder()}
				class="w-full resize-y rounded-lg border border-[#e3e0d5] bg-white px-3 py-2 font-mono text-[13px] leading-relaxed transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
			></textarea>
			<div class="flex items-center gap-2">
				<button
					onclick={saveDraft}
					disabled={busy}
					class="rounded-lg bg-[#d97757] px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-[#bd5d3a] disabled:opacity-50"
				>
					{m.settings_save()}
				</button>
				<button
					onclick={cancelEdit}
					class="rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-500 transition hover:text-neutral-800"
				>
					{m.cancel()}
				</button>
			</div>
		</div>
	{:else if current}
		<div class="space-y-4">
			{#if current.summary}
				<div>
					<p class="mb-1 text-[10px] font-semibold tracking-wide text-neutral-400 uppercase">
						{m.settings_memory_summary()}
					</p>
					<p class="text-sm text-neutral-700">{current.summary}</p>
				</div>
			{/if}
			{#if current.details}
				<div>
					<p class="mb-1 text-[10px] font-semibold tracking-wide text-neutral-400 uppercase">
						{m.settings_memory_details()}
					</p>
					<div class="memory-details"><Markdown content={current.details} /></div>
				</div>
			{/if}
			{#if !current.summary && !current.details}
				<p class="text-xs text-neutral-400">{m.settings_memory_empty_topic()}</p>
			{/if}
		</div>
	{/if}
{/if}

<style>
	/* The shared Markdown component styles for chat prose (serif, 16px); tone it
	   down for the compact settings panel. */
	.memory-details :global(.prose-chat) {
		font-family: var(--font-sans);
		font-size: 14px;
		line-height: 1.65;
	}
</style>

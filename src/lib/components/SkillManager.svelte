<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import Icon from './Icon.svelte';
	import Markdown from './Markdown.svelte';
	import { listSkills, saveSkill, removeSkill, type UserSkill } from '$lib/skills';

	// Learned skills (procedural playbooks) — same list → detail/edit shell as
	// the memory manager, with name / description / markdown content.
	let skills = $state<UserSkill[]>([]);
	let loaded = $state(false);
	let openId = $state<string | null>(null); // null = list; '__new__' = new draft
	let editing = $state(false);
	let draft = $state({ name: '', description: '', content: '' });
	let busy = $state(false);

	listSkills().then((list) => {
		skills = list;
		loaded = true;
	});

	const current = $derived(
		openId && openId !== '__new__' ? (skills.find((sk) => sk.id === openId) ?? null) : null
	);

	function openDetail(sk: UserSkill) {
		openId = sk.id;
		editing = false;
	}
	function openNew() {
		openId = '__new__';
		editing = true;
		draft = { name: '', description: '', content: '' };
	}
	function startEdit() {
		if (!current) return;
		draft = { name: current.name, description: current.description, content: current.content };
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
			name: draft.name.trim(),
			description: draft.description.trim(),
			content: draft.content.trim()
		};
		if (!payload.name || !payload.content) return;
		busy = true;
		const saved = await saveSkill({
			...(openId && openId !== '__new__' ? { id: openId } : {}),
			...payload
		});
		busy = false;
		if (saved) {
			const idx = skills.findIndex((sk) => sk.id === saved.id);
			if (idx >= 0) skills[idx] = saved;
			else skills = [...skills, saved];
			openId = saved.id;
			editing = false;
		}
	}

	async function deleteCurrent() {
		if (!current || busy) return;
		const id = current.id;
		busy = true;
		const ok = await removeSkill(id);
		busy = false;
		if (ok) {
			skills = skills.filter((sk) => sk.id !== id);
			back();
		}
	}
</script>

{#if openId === null}
	<!-- LIST -->
	<div class="mb-2 flex items-center justify-between">
		<h3 class="text-sm font-semibold text-neutral-800">{m.settings_skills_stored()}</h3>
	</div>

	{#if !loaded}
		<div class="grid place-items-center py-8">
			<span class="size-6 animate-spin rounded-full border-[3px] border-[#e3e0d5] border-t-[#d97757]"></span>
		</div>
	{:else if skills.length === 0}
		<p class="rounded-xl border border-dashed border-[#e3e0d5] px-4 py-6 text-center text-xs text-neutral-400">
			{m.settings_skills_empty()}
		</p>
	{:else}
		<div class="space-y-1.5">
			{#each skills as sk (sk.id)}
				<button
					onclick={() => openDetail(sk)}
					class="flex w-full items-center gap-2.5 rounded-lg border border-[#e9e6dd] bg-[#faf9f5] px-3 py-2.5 text-left transition hover:border-[#d97757]/40 hover:bg-[#d97757]/5"
				>
					<Icon name="graduation-cap" size={14} class="shrink-0 text-[#bd5d3a]" />
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm font-medium text-neutral-800">{sk.name}</span>
						{#if sk.description}
							<span class="block truncate text-xs text-neutral-500">{sk.description}</span>
						{/if}
					</span>
					{#if sk.uses > 0}
						<span class="shrink-0 text-[11px] text-neutral-400">{m.settings_skills_uses({ count: sk.uses })}</span>
					{/if}
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
		{m.settings_skills_add()}
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
				{openId === '__new__' ? m.settings_skills_add() : m.settings_memory_edit()}
			{:else}
				{current?.name}
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
				bind:value={draft.name}
				maxlength="120"
				placeholder={m.settings_skills_name_placeholder()}
				class="w-full rounded-lg border border-[#e3e0d5] bg-white px-3 py-2 text-sm font-medium transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
			/>
			<input
				bind:value={draft.description}
				maxlength="300"
				placeholder={m.settings_skills_desc_placeholder()}
				class="w-full rounded-lg border border-[#e3e0d5] bg-white px-3 py-2 text-sm transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
			/>
			<textarea
				bind:value={draft.content}
				maxlength="12000"
				rows="12"
				placeholder={m.settings_skills_content_placeholder()}
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
			{#if current.description}
				<p class="text-sm text-neutral-700">{current.description}</p>
			{/if}
			<div class="skill-content"><Markdown content={current.content} /></div>
		</div>
	{/if}
{/if}

<style>
	/* Chat prose is serif/16px; tone it down for the compact settings panel. */
	.skill-content :global(.prose-chat) {
		font-family: var(--font-sans);
		font-size: 14px;
		line-height: 1.65;
	}
</style>

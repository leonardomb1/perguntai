<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { getToken } from '$lib/session';
	import Icon from './Icon.svelte';
	import HelpTip from './HelpTip.svelte';
	import Markdown from './Markdown.svelte';

	/**
	 * Shared-skill governance (console → Habilidades): the review queue for
	 * skills users' assistants proposed for org/department use, plus the list
	 * of active shared skills. The agent can never activate a shared skill by
	 * itself — this panel is where a human ratifies it.
	 */

	interface SharedSkill {
		id: string;
		name: string;
		description: string;
		content: string;
		enabled?: boolean;
		proposedBy?: string;
		updatedAt: string;
		uses: number;
	}
	interface Row {
		scope: string; // 'org' | dept id (API addressing)
		scopeLabel: string;
		skill: SharedSkill;
	}

	let rows = $state<Row[]>([]);
	let loaded = $state(false);
	let busyId = $state<string | null>(null);
	let openId = $state<string | null>(null);

	const headers = () => ({
		Authorization: `Bearer ${getToken() ?? ''}`,
		'Content-Type': 'application/json'
	});

	async function refresh() {
		try {
			const res = await fetch('/api/admin/skills', { headers: headers() });
			if (!res.ok) return;
			const data = (await res.json()) as {
				org: SharedSkill[];
				departments: { id: string; name: string; skills: SharedSkill[] }[];
			};
			rows = [
				...data.org.map((skill) => ({ scope: 'org', scopeLabel: m.admin_skills_scope_org(), skill })),
				...data.departments.flatMap((d) =>
					d.skills.map((skill) => ({ scope: d.id, scopeLabel: d.name, skill }))
				)
			];
		} finally {
			loaded = true;
		}
	}
	void refresh();

	const pending = $derived(rows.filter((r) => r.skill.enabled !== true));
	const active = $derived(rows.filter((r) => r.skill.enabled === true));

	async function setEnabled(row: Row, enabled: boolean) {
		busyId = row.skill.id;
		await fetch('/api/admin/skills', {
			method: 'PATCH',
			headers: headers(),
			body: JSON.stringify({ scope: row.scope, id: row.skill.id, enabled })
		}).catch(() => {});
		busyId = null;
		await refresh();
	}

	async function remove(row: Row) {
		busyId = row.skill.id;
		await fetch(
			`/api/admin/skills?scope=${encodeURIComponent(row.scope)}&id=${encodeURIComponent(row.skill.id)}`,
			{ method: 'DELETE', headers: headers() }
		).catch(() => {});
		busyId = null;
		await refresh();
	}
</script>

{#snippet skillRow(row: Row, actions: 'pending' | 'active')}
	<div class="border-b border-[#efede3] last:border-b-0">
		<div class="flex items-center gap-3 px-4 py-3">
			<button
				onclick={() => (openId = openId === row.skill.id ? null : row.skill.id)}
				class="flex min-w-0 flex-1 items-center gap-3 text-left"
			>
				<Icon
					name="chevron-down"
					size={13}
					class="shrink-0 text-neutral-400 transition-transform {openId === row.skill.id ? '' : '-rotate-90'}"
				/>
				<span class="min-w-0 flex-1">
					<span class="block truncate text-sm font-medium text-neutral-800">{row.skill.name}</span>
					<span class="block truncate text-xs text-neutral-500">{row.skill.description}</span>
				</span>
			</button>
			<span class="hidden shrink-0 rounded-full border border-[#e3e0d5] px-2 py-0.5 text-[11px] text-neutral-500 sm:block">
				{row.scopeLabel}
			</span>
			{#if row.skill.proposedBy}
				<span class="hidden shrink-0 text-xs text-neutral-400 md:block">
					{m.admin_skills_by({ user: row.skill.proposedBy })}
				</span>
			{/if}
			{#if actions === 'active' && row.skill.uses > 0}
				<span class="hidden shrink-0 text-xs text-neutral-400 md:block">
					{m.settings_skills_uses({ count: row.skill.uses })}
				</span>
			{/if}
			<span class="flex shrink-0 items-center gap-1.5">
				{#if actions === 'pending'}
					<button
						onclick={() => setEnabled(row, true)}
						disabled={busyId === row.skill.id}
						class="rounded-lg bg-[#128a5f] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[#0d6b4a] disabled:opacity-50"
					>
						{m.admin_skills_approve()}
					</button>
					<button
						onclick={() => remove(row)}
						disabled={busyId === row.skill.id}
						class="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50"
					>
						{m.admin_skills_reject()}
					</button>
				{:else}
					<button
						onclick={() => setEnabled(row, false)}
						disabled={busyId === row.skill.id}
						class="rounded-lg border border-[#e3e0d5] px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:bg-[#faf9f5] disabled:opacity-50"
					>
						{m.admin_skills_suspend()}
					</button>
					<button
						onclick={() => remove(row)}
						disabled={busyId === row.skill.id}
						class="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50"
					>
						{m.admin_skills_remove()}
					</button>
				{/if}
			</span>
		</div>
		{#if openId === row.skill.id}
			<div class="skill-body mx-4 mb-3 rounded-lg border border-[#e9e6dd] bg-[#faf9f5] px-4 py-3">
				<Markdown content={row.skill.content} />
			</div>
		{/if}
	</div>
{/snippet}

<div class="space-y-5">
	<section class="overflow-hidden rounded-xl border border-[#e3e0d5] bg-white">
		<div class="flex items-center gap-2 border-b border-[#efede3] px-4 py-3">
			<h3 class="text-sm font-semibold text-neutral-800">{m.admin_skills_pending()}</h3>
			<HelpTip text={m.admin_skills_pending_help()} />
			{#if pending.length}
				<span class="rounded-full bg-[#d97757]/10 px-2 py-0.5 text-[11px] font-semibold text-[#bd5d3a]">
					{pending.length}
				</span>
			{/if}
		</div>
		{#if !loaded}
			<div class="grid place-items-center py-8">
				<span class="size-6 animate-spin rounded-full border-[3px] border-[#e3e0d5] border-t-[#d97757]"></span>
			</div>
		{:else if pending.length === 0}
			<p class="px-4 py-6 text-center text-xs text-neutral-400">{m.admin_skills_none_pending()}</p>
		{:else}
			{#each pending as row (row.skill.id)}
				{@render skillRow(row, 'pending')}
			{/each}
		{/if}
	</section>

	<section class="overflow-hidden rounded-xl border border-[#e3e0d5] bg-white">
		<div class="flex items-center gap-2 border-b border-[#efede3] px-4 py-3">
			<h3 class="text-sm font-semibold text-neutral-800">{m.admin_skills_active()}</h3>
			<HelpTip text={m.admin_skills_active_help()} />
		</div>
		{#if !loaded}
			<div class="grid place-items-center py-8">
				<span class="size-6 animate-spin rounded-full border-[3px] border-[#e3e0d5] border-t-[#d97757]"></span>
			</div>
		{:else if active.length === 0}
			<p class="px-4 py-6 text-center text-xs text-neutral-400">{m.admin_skills_none_active()}</p>
		{:else}
			{#each active as row (row.skill.id)}
				{@render skillRow(row, 'active')}
			{/each}
		{/if}
	</section>
</div>

<style>
	.skill-body :global(.prose-chat) {
		font-family: var(--font-sans);
		font-size: 13.5px;
		line-height: 1.6;
	}
</style>

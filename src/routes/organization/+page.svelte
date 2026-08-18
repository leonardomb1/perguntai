<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import Icon from '$lib/components/Icon.svelte';
	import KnowledgeBlocks from '$lib/components/KnowledgeBlocks.svelte';
	import DocumentLibrary from '$lib/components/DocumentLibrary.svelte';
	import DeptRuleEditor from '$lib/components/DeptRuleEditor.svelte';
	import { hasSession } from '$lib/session';
	import { fetchSettings } from '$lib/settings';
	import { newId } from '$lib/id';
	import {
		getOrg,
		saveOrg,
		matchesProfile,
		type OrgKnowledgeEntry,
		type Department,
		type CallerProfile
	} from '$lib/admin';
	import { EMPTY_MATCH } from '$lib/dept-rules';

	// Redirect to login without a session; bounce non-admins to chat. The
	// /api/admin/org routes enforce the admin role again on every request.
	$effect(() => {
		if (browser && !hasSession()) goto('/login');
	});
	$effect(() => {
		if (!browser || !hasSession()) return;
		fetchSettings().then((s) => {
			if (s && s.role !== 'admin') goto('/');
		});
	});

	type Section = 'knowledge' | 'departments';
	let section = $state<Section>('knowledge');

	/** Mobile only: the console rail is a drawer, closed by default. */
	let railOpen = $state(false);
	/** Mobile only: the departments pane shows either the list or the editor. */
	let deptDetail = $state(false);

	type EditDept = Department;

	let loaded = $state(false);
	let orgPrompt = $state('');
	let entries = $state<OrgKnowledgeEntry[]>([]);
	let departments = $state<EditDept[]>([]);
	/** Department ids that exist server-side (docs can only attach to saved depts). */
	let persistedDeptIds = $state(new Set<string>());
	let you = $state<CallerProfile>({ claims: {} });
	let selectedDeptId = $state<string | null>(null);
	let saved = $state(''); // JSON snapshot of the last persisted state
	let saving = $state(false);
	let savedFlash = $state(false);

	// The server always answers a complete match; this only guards a stale client.
	function normalizeDepts(list: Department[]): EditDept[] {
		return list.map((d) => ({
			...d,
			match: { mode: d.match?.mode === 'all' ? 'all' : 'any', rules: d.match?.rules ?? [] },
			knowledge: d.knowledge ?? []
		}));
	}

	const snapshot = () => JSON.stringify({ orgPrompt, entries, departments });
	const dirty = $derived(loaded && snapshot() !== saved);

	$effect(() => {
		if (!browser || !hasSession()) return;
		getOrg().then((cfg) => {
			if (cfg) {
				orgPrompt = cfg.orgSystemPrompt;
				entries = cfg.orgKnowledge;
				departments = normalizeDepts(cfg.departments);
				persistedDeptIds = new Set(cfg.departments.map((d) => d.id));
				you = cfg.you;
				selectedDeptId = departments[0]?.id ?? null;
			}
			loaded = true;
			saved = snapshot();
		});
	});

	async function save() {
		saving = true;
		const result = await saveOrg({ orgSystemPrompt: orgPrompt, orgKnowledge: entries, departments });
		if (result) {
			orgPrompt = result.orgSystemPrompt;
			entries = result.orgKnowledge;
			departments = normalizeDepts(result.departments);
			persistedDeptIds = new Set(result.departments.map((d) => d.id));
			if (!departments.some((d) => d.id === selectedDeptId)) selectedDeptId = departments[0]?.id ?? null;
			saved = snapshot();
			savedFlash = true;
			setTimeout(() => (savedFlash = false), 2000);
		}
		saving = false;
	}

	function addDept() {
		const id = newId();
		departments = [
			...departments,
			{ id, name: '', enabled: true, match: { ...EMPTY_MATCH, rules: [] }, knowledge: [] }
		];
		selectDept(id);
	}
	function selectDept(id: string) {
		selectedDeptId = id;
		deptDetail = true; // no-op above sm, where both panes are visible
	}
	function removeDept(id: string) {
		departments = departments.filter((d) => d.id !== id);
		if (selectedDeptId === id) {
			selectedDeptId = departments[0]?.id ?? null;
			deptDetail = false; // back to the list on mobile
		}
	}

	const di = $derived(departments.findIndex((d) => d.id === selectedDeptId));
	const enabledCount = $derived(entries.filter((e) => e.enabled && e.body.trim()).length);

	const nav = [
		{ id: 'knowledge' as const, icon: 'book' as const, label: m.org_nav_knowledge() },
		{ id: 'departments' as const, icon: 'building' as const, label: m.org_nav_departments() }
	];
</script>

<svelte:head>
	<title>{m.org_title()} — PerguntAI</title>
</svelte:head>

<div class="relative flex h-dvh overflow-hidden bg-[#faf9f5] text-neutral-800">
	<!-- console rail — a drawer on phones, a static column from sm up -->
	<aside
		class="absolute inset-y-0 left-0 z-30 flex w-60 shrink-0 flex-col border-r border-[#e3e0d5] bg-[#f5f4ee] transition-transform sm:static sm:translate-x-0
			{railOpen ? 'translate-x-0' : '-translate-x-full'}"
	>
		<div class="flex items-center gap-2 border-b border-[#e3e0d5] p-4">
			<button
				onclick={() => goto('/')}
				class="grid size-8 shrink-0 place-items-center rounded-lg text-neutral-500 transition hover:bg-[#d97757]/10 hover:text-[#bd5d3a]"
				title={m.back_to_chat()}
				aria-label={m.back_to_chat()}
			>
				<Icon name="arrow-right" size={15} class="rotate-180" />
			</button>
			<div class="min-w-0 flex-1">
				<h1 class="truncate text-sm font-semibold">{m.org_title()}</h1>
				<p class="truncate text-[11px] text-neutral-500">{m.org_console_label()}</p>
			</div>
			<button
				onclick={() => (railOpen = false)}
				class="shrink-0 rounded-lg p-1.5 text-neutral-500 transition hover:bg-[#d97757]/10 sm:hidden"
				title={m.close_sidebar()}
				aria-label={m.close_sidebar()}
			>
				<Icon name="x" size={16} />
			</button>
		</div>
		<nav class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
			{#each nav as item (item.id)}
				<button
					onclick={() => {
						section = item.id;
						railOpen = false;
					}}
					class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition
						{section === item.id ? 'bg-[#d97757]/10 text-[#bd5d3a]' : 'text-neutral-600 hover:bg-[#eceae1]'}"
				>
					<Icon name={item.icon} size={16} />
					<span class="min-w-0 flex-1 truncate">{item.label}</span>
				</button>
			{/each}
		</nav>
		<p class="border-t border-[#e3e0d5] p-3 text-[11px] leading-snug text-neutral-500">
			{m.org_rail_footer()}
		</p>
	</aside>

	{#if railOpen}
		<button
			class="absolute inset-0 z-20 bg-black/20 sm:hidden"
			onclick={() => (railOpen = false)}
			aria-label={m.close_sidebar()}
		></button>
	{/if}

	<!-- main -->
	<main class="flex min-w-0 flex-1 flex-col">
		<header class="flex items-center gap-3 border-b border-[#e3e0d5] bg-white px-4 py-3 sm:px-6">
			<button
				onclick={() => (railOpen = true)}
				class="-ml-1 shrink-0 rounded-lg border border-[#e3e0d5] p-2 text-neutral-600 sm:hidden"
				title={m.open_sidebar()}
				aria-label={m.open_sidebar()}
			>
				<Icon name="menu" size={16} />
			</button>
			<div class="min-w-0 flex-1">
				<h2 class="truncate text-sm font-semibold">
					{section === 'knowledge' ? m.org_nav_knowledge() : m.org_dept_title()}
				</h2>
				<p class="hidden truncate text-[11px] text-neutral-500 sm:block">
					{section === 'knowledge' ? m.org_subtitle() : m.org_dept_subtitle()}
				</p>
			</div>
			{#if savedFlash}
				<span class="flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-600">
					<Icon name="check" size={13} />
					<span class="hidden sm:inline">{m.settings_saved()}</span>
				</span>
			{:else if dirty}
				<span class="hidden text-xs text-neutral-400 sm:inline">{m.org_unsaved()}</span>
			{/if}
			<button
				onclick={save}
				disabled={!dirty || saving}
				class="flex shrink-0 items-center gap-1.5 rounded-lg bg-[#d97757] px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-[#bd5d3a] disabled:opacity-40"
			>
				{saving ? m.org_saving() : m.settings_save()}
			</button>
		</header>

		{#if !loaded}
			<div class="grid flex-1 place-items-center">
				<span class="size-7 animate-spin rounded-full border-[3px] border-[#e3e0d5] border-t-[#d97757]"></span>
			</div>
		{:else if section === 'knowledge'}
			<div class="min-h-0 flex-1 overflow-y-auto">
				<div class="mx-auto max-w-3xl space-y-8 px-4 py-6 sm:px-6 sm:py-8">
					<section>
						<h3 class="text-sm font-semibold text-neutral-900">{m.org_general_title()}</h3>
						<p class="mt-0.5 mb-3 text-xs text-neutral-500">{m.org_general_hint()}</p>
						<textarea
							bind:value={orgPrompt}
							maxlength="4000"
							rows="4"
							placeholder={m.org_general_placeholder()}
							class="w-full resize-y rounded-xl border border-[#e3e0d5] bg-white px-3.5 py-3 text-sm leading-relaxed transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
						></textarea>
					</section>

					<section>
						<div class="mb-3 flex items-end justify-between gap-3">
							<div>
								<h3 class="text-sm font-semibold text-neutral-900">{m.org_kb_title()}</h3>
								<p class="mt-0.5 text-xs text-neutral-500">{m.org_kb_hint()}</p>
							</div>
							<span class="shrink-0 text-[11px] text-neutral-400">{m.org_kb_active({ count: enabledCount })}</span>
						</div>
						<KnowledgeBlocks bind:entries />
					</section>

					<section>
						<h3 class="text-sm font-semibold text-neutral-900">{m.org_docs_title()}</h3>
						<p class="mt-0.5 mb-3 text-xs text-neutral-500">{m.org_docs_hint()}</p>
						<DocumentLibrary scope="org" />
					</section>

					<p class="border-t border-[#efede3] pt-4 text-[11px] leading-relaxed text-neutral-400">
						{m.org_footer_note()}
					</p>
				</div>
			</div>
		{:else}
			<!-- departments: master list + editor. Side by side from sm up; on
			     phones the two take turns filling the pane (see `deptDetail`). -->

			<div class="flex min-h-0 flex-1">
				<div
					class="flex w-full shrink-0 flex-col border-r border-[#e3e0d5] bg-[#faf9f5] sm:w-60
						{deptDetail ? 'max-sm:hidden' : ''}"
				>
					<nav class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
						{#if departments.length === 0}
							<p class="px-3 py-6 text-center text-xs text-neutral-400">{m.org_dept_empty()}</p>
						{:else}
							{#each departments as dept (dept.id)}
								<button
									onclick={() => selectDept(dept.id)}
									class="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition
										{selectedDeptId === dept.id ? 'bg-[#d97757]/10' : 'hover:bg-[#eceae1]'}"
								>
									<span class="size-1.5 shrink-0 rounded-full {dept.enabled ? 'bg-[#1baf7a]' : 'bg-neutral-300'}"></span>
									<span class="min-w-0 flex-1 truncate {dept.name.trim() ? 'font-medium' : 'text-neutral-400 italic'}">
										{dept.name.trim() || m.org_dept_untitled()}
									</span>
									{#if matchesProfile(dept.match, you)}
										<span class="shrink-0 rounded bg-[#1baf7a]/12 px-1 text-[9px] font-semibold text-[#0d8a5f]">{m.org_dept_you_badge()}</span>
									{/if}
								</button>
							{/each}
						{/if}
					</nav>
					<button
						onclick={addDept}
						class="m-2 flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-[#d8d4c6] px-3 py-2 text-sm font-medium text-neutral-500 transition hover:border-[#d97757]/50 hover:bg-[#d97757]/5 hover:text-[#bd5d3a]"
					>
						<Icon name="plus" size={15} />
						{m.org_dept_add()}
					</button>
				</div>

				<div class="min-h-0 flex-1 overflow-y-auto {deptDetail ? '' : 'max-sm:hidden'}">
					{#if di < 0}
						<div class="grid h-full place-items-center">
							<p class="text-sm text-neutral-400">{m.org_dept_none_selected()}</p>
						</div>
					{:else}
						<div class="mx-auto max-w-2xl space-y-7 px-4 py-6 sm:px-6 sm:py-8">
							<button
								onclick={() => (deptDetail = false)}
								class="flex items-center gap-1.5 text-xs font-medium text-neutral-500 transition hover:text-[#bd5d3a] sm:hidden"
							>
								<Icon name="arrow-right" size={13} class="rotate-180" />
								{m.org_nav_departments()}
							</button>

							<!-- header row: name + enable + delete -->
							<div class="flex items-center gap-2">
								<input
									bind:value={departments[di].name}
									maxlength="120"
									placeholder={m.org_dept_name_placeholder()}
									class="min-w-0 flex-1 rounded-lg border border-[#e3e0d5] bg-white px-3.5 py-2 text-sm font-semibold transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
								/>
								<button
									onclick={() => (departments[di].enabled = !departments[di].enabled)}
									role="switch"
									aria-checked={departments[di].enabled}
									title={departments[di].enabled ? m.org_dept_enabled() : m.org_dept_disabled()}
									class="relative h-5 w-9 shrink-0 rounded-full transition {departments[di].enabled ? 'bg-[#d97757]' : 'bg-neutral-300'}"
								>
									<span class="absolute top-0.5 size-4 rounded-full bg-white transition-all {departments[di].enabled ? 'left-4' : 'left-0.5'}"></span>
								</button>
								<button
									onclick={() => removeDept(departments[di].id)}
									class="grid size-9 shrink-0 place-items-center rounded-lg text-neutral-400 transition hover:bg-red-50 hover:text-red-600"
									title={m.org_dept_remove()}
									aria-label={m.org_dept_remove()}
								>
									<Icon name="trash" size={15} />
								</button>
							</div>

							<!-- membership rule -->
							<section>
								<div class="mb-2 flex items-center gap-2">
									<h3 class="text-sm font-semibold text-neutral-900">{m.org_dept_rule_title()}</h3>
									{#if matchesProfile(departments[di].match, you)}
										<span class="flex items-center gap-1 rounded-full bg-[#1baf7a]/12 px-2 py-0.5 text-[11px] font-medium text-[#0d8a5f]">
											<Icon name="check" size={11} />{m.org_dept_matches_you()}
										</span>
									{:else}
										<span class="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-500">{m.org_dept_matches_you_not()}</span>
									{/if}
								</div>
								<p class="mb-3 text-xs text-neutral-500">{m.org_dept_rule_hint()}</p>

								<DeptRuleEditor bind:match={departments[di].match} you={you.claims} />
							</section>

							<!-- department knowledge -->
							<section>
								<h3 class="text-sm font-semibold text-neutral-900">{m.org_dept_kb_title()}</h3>
								<p class="mt-0.5 mb-3 text-xs text-neutral-500">{m.org_dept_kb_hint()}</p>
								<KnowledgeBlocks bind:entries={departments[di].knowledge} />
							</section>

							<!-- department documents (only for saved departments) -->
							<section>
								<h3 class="text-sm font-semibold text-neutral-900">{m.org_docs_title()}</h3>
								<p class="mt-0.5 mb-3 text-xs text-neutral-500">{m.org_dept_docs_hint()}</p>
								{#if persistedDeptIds.has(departments[di].id)}
									{#key departments[di].id}
										<DocumentLibrary scope={departments[di].id} />
									{/key}
								{:else}
									<p class="rounded-lg border border-dashed border-[#e3e0d5] px-3 py-2.5 text-xs text-neutral-400">
										{m.org_dept_docs_save_first()}
									</p>
								{/if}
							</section>

							<p class="border-t border-[#efede3] pt-4 text-[11px] leading-relaxed text-neutral-400">
								{m.org_footer_note()}
							</p>
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</main>
</div>

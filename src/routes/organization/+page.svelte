<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import Icon from '$lib/components/Icon.svelte';
	import KnowledgeBlocks from '$lib/components/KnowledgeBlocks.svelte';
	import DocumentLibrary from '$lib/components/DocumentLibrary.svelte';
	import DeptRuleEditor from '$lib/components/DeptRuleEditor.svelte';
	import HelpTip from '$lib/components/HelpTip.svelte';
	import AdminPanel from '$lib/components/AdminPanel.svelte';
	import SecurityPanel from '$lib/components/SecurityPanel.svelte';
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

	type Section = 'knowledge' | 'users' | 'stats' | 'audit';
	let section = $state<Section>('knowledge');
	/** Users/stats apply immediately — no batch save, so no Save button there. */
	const adminSection = $derived(section === 'users' || section === 'stats' || section === 'audit');

	/** Mobile only: the console rail is a drawer, closed by default. */
	let railOpen = $state(false);
	/** Mobile only: the knowledge pane shows either the scope list or the editor. */
	let scopeDetail = $state(false);

	type EditDept = Department;

	let loaded = $state(false);
	let orgPrompt = $state('');
	let entries = $state<OrgKnowledgeEntry[]>([]);
	let departments = $state<EditDept[]>([]);
	/** Department ids that exist server-side (docs can only attach to saved depts). */
	let persistedDeptIds = $state(new Set<string>());
	let you = $state<CallerProfile>({ claims: {} });
	/** Knowledge is edited per scope: the whole org, or one department. */
	let selectedScope = $state<'org' | string>('org');
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
			if (selectedScope !== 'org' && !departments.some((d) => d.id === selectedScope)) {
				selectedScope = 'org';
			}
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
		selectScope(id);
	}
	function selectScope(id: 'org' | string) {
		selectedScope = id;
		scopeDetail = true; // no-op above sm, where both panes are visible
	}
	function removeDept(id: string) {
		departments = departments.filter((d) => d.id !== id);
		if (selectedScope === id) {
			selectedScope = 'org';
			scopeDetail = false; // back to the list on mobile
		}
	}

	const di = $derived(
		selectedScope === 'org' ? -1 : departments.findIndex((d) => d.id === selectedScope)
	);
	const enabledCount = $derived(entries.filter((e) => e.enabled && e.body.trim()).length);

	const nav = [
		{ id: 'knowledge' as const, icon: 'book' as const, label: m.org_nav_knowledge() },
		{ id: 'users' as const, icon: 'users' as const, label: m.admin_users_title() },
		{ id: 'stats' as const, icon: 'activity' as const, label: m.admin_stats_tab() },
		{ id: 'audit' as const, icon: 'eye' as const, label: m.org_nav_audit() }
	];

	const sectionMeta = $derived(
		({
			knowledge: { title: m.org_nav_knowledge(), subtitle: m.org_subtitle() },
			users: { title: m.admin_users_title(), subtitle: m.org_users_subtitle() },
			stats: { title: m.admin_stats_tab(), subtitle: m.org_stats_subtitle() },
			audit: { title: m.org_nav_audit(), subtitle: m.org_audit_subtitle() }
		})[section]
	);
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
		<div class="flex h-16 items-center gap-2 border-b border-[#e3e0d5] px-4">
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
					class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[15px] font-medium transition
						{section === item.id ? 'bg-[#d97757]/10 text-[#bd5d3a]' : 'text-neutral-600 hover:bg-[#eceae1]'}"
				>
					<Icon name={item.icon} size={16} />
					<span class="min-w-0 flex-1 truncate">{item.label}</span>
				</button>
			{/each}
		</nav>
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
		<header class="flex h-16 shrink-0 items-center gap-3 border-b border-[#e3e0d5] bg-white px-4 sm:px-6">
			<button
				onclick={() => (railOpen = true)}
				class="-ml-1 shrink-0 rounded-lg border border-[#e3e0d5] p-2 text-neutral-600 sm:hidden"
				title={m.open_sidebar()}
				aria-label={m.open_sidebar()}
			>
				<Icon name="menu" size={16} />
			</button>
			<div class="min-w-0 flex-1">
				<h2 class="truncate text-base font-semibold">{sectionMeta.title}</h2>
				<p class="hidden truncate text-[13px] text-neutral-500 sm:block">{sectionMeta.subtitle}</p>
			</div>
			{#if !adminSection}
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
			{/if}
		</header>

		{#if adminSection}
			<div class="min-h-0 flex-1 overflow-y-auto">
				<div class="mx-auto max-w-5xl px-4 py-5 sm:px-6">
					{#if section === 'audit'}
						<SecurityPanel />
					{:else}
						<AdminPanel view={section === 'users' ? 'users' : 'stats'} />
					{/if}
				</div>
			</div>
		{:else if !loaded}
			<div class="grid flex-1 place-items-center">
				<span class="size-7 animate-spin rounded-full border-[3px] border-[#e3e0d5] border-t-[#d97757]"></span>
			</div>
		{:else}
			<!-- knowledge: scope list (org + departments) + editor. Side by side
			     from sm up; on phones the two take turns (see `scopeDetail`). -->
			<div class="flex min-h-0 flex-1">
				<div
					class="flex w-full shrink-0 flex-col border-r border-[#e3e0d5] bg-[#faf9f5] sm:w-60
						{scopeDetail ? 'max-sm:hidden' : ''}"
				>
					<nav class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
						<button
							onclick={() => selectScope('org')}
							class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[15px] font-medium transition
								{selectedScope === 'org' ? 'bg-[#d97757]/10 text-[#bd5d3a]' : 'text-neutral-600 hover:bg-[#eceae1]'}"
						>
							<Icon name="building" size={15} />
							<span class="min-w-0 flex-1 truncate">{m.org_scope_org()}</span>
						</button>

						<p class="px-3 pt-4 pb-1 text-[10px] font-semibold tracking-wide text-neutral-400 uppercase">
							{m.org_nav_departments()}
						</p>
						{#if departments.length === 0}
							<p class="px-3 py-4 text-center text-xs text-neutral-400">{m.org_dept_empty()}</p>
						{:else}
							{#each departments as dept (dept.id)}
								<button
									onclick={() => selectScope(dept.id)}
									class="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[15px] transition
										{selectedScope === dept.id ? 'bg-[#d97757]/10' : 'hover:bg-[#eceae1]'}"
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

				<div class="min-h-0 flex-1 overflow-y-auto {scopeDetail ? '' : 'max-sm:hidden'}">
					{#if selectedScope === 'org'}
						<div class="mx-auto max-w-3xl space-y-4 px-4 py-5 sm:px-6">
							<button
								onclick={() => (scopeDetail = false)}
								class="flex items-center gap-1.5 text-xs font-medium text-neutral-500 transition hover:text-[#bd5d3a] sm:hidden"
							>
								<Icon name="arrow-right" size={13} class="rotate-180" />
								{m.org_nav_knowledge()}
							</button>

							<section class="rounded-xl border border-[#e3e0d5] bg-white p-5">
								<h3 class="mb-3 flex items-center gap-1.5 text-base font-semibold text-neutral-900">
									{m.org_general_title()}
									<HelpTip text={m.org_general_hint()} />
								</h3>
								<textarea
									bind:value={orgPrompt}
									maxlength="4000"
									rows="4"
									placeholder={m.org_general_placeholder()}
									class="w-full resize-y rounded-lg border border-[#e3e0d5] bg-[#faf9f5]/60 px-3.5 py-3 text-sm leading-relaxed transition focus:border-[#d97757] focus:bg-white focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
								></textarea>
							</section>

							<section class="rounded-xl border border-[#e3e0d5] bg-white p-5">
								<div class="mb-3 flex items-end justify-between gap-3">
									<h3 class="flex items-center gap-1.5 text-base font-semibold text-neutral-900">
										{m.org_kb_title()}
										<HelpTip text={`${m.org_kb_hint()} ${m.org_footer_note()}`} />
									</h3>
									<span class="shrink-0 text-[11px] text-neutral-400">{m.org_kb_active({ count: enabledCount })}</span>
								</div>
								<KnowledgeBlocks bind:entries />
							</section>

							<section class="rounded-xl border border-[#e3e0d5] bg-white p-5">
								<h3 class="mb-3 flex items-center gap-1.5 text-base font-semibold text-neutral-900">
									{m.org_docs_title()}
									<HelpTip text={m.org_docs_hint()} />
								</h3>
								<DocumentLibrary scope="org" />
							</section>

						</div>
					{:else if di < 0}
						<div class="grid h-full place-items-center">
							<p class="text-sm text-neutral-400">{m.org_dept_none_selected()}</p>
						</div>
					{:else}
						<div class="mx-auto max-w-3xl space-y-4 px-4 py-5 sm:px-6">
							<button
								onclick={() => (scopeDetail = false)}
								class="flex items-center gap-1.5 text-xs font-medium text-neutral-500 transition hover:text-[#bd5d3a] sm:hidden"
							>
								<Icon name="arrow-right" size={13} class="rotate-180" />
								{m.org_nav_knowledge()}
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
							<section class="rounded-xl border border-[#e3e0d5] bg-white p-5">
								<div class="mb-2 flex items-center gap-2">
									<h3 class="flex items-center gap-1.5 text-base font-semibold text-neutral-900">
										{m.org_dept_rule_title()}
										<HelpTip text={m.org_dept_rule_hint()} />
									</h3>
									{#if matchesProfile(departments[di].match, you)}
										<span class="flex items-center gap-1 rounded-full bg-[#1baf7a]/12 px-2 py-0.5 text-[11px] font-medium text-[#0d8a5f]">
											<Icon name="check" size={11} />{m.org_dept_matches_you()}
										</span>
									{:else}
										<span class="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-500">{m.org_dept_matches_you_not()}</span>
									{/if}
								</div>

								<DeptRuleEditor bind:match={departments[di].match} you={you.claims} />
							</section>

							<!-- department knowledge -->
							<section class="rounded-xl border border-[#e3e0d5] bg-white p-5">
								<h3 class="mb-3 flex items-center gap-1.5 text-base font-semibold text-neutral-900">
									{m.org_dept_kb_title()}
									<HelpTip text={`${m.org_dept_kb_hint()} ${m.org_footer_note()}`} />
								</h3>
								<KnowledgeBlocks bind:entries={departments[di].knowledge} />
							</section>

							<!-- department documents (only for saved departments) -->
							<section class="rounded-xl border border-[#e3e0d5] bg-white p-5">
								<h3 class="mb-3 flex items-center gap-1.5 text-base font-semibold text-neutral-900">
									{m.org_docs_title()}
									<HelpTip text={m.org_dept_docs_hint()} />
								</h3>
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

						</div>
					{/if}
				</div>
			</div>
		{/if}
	</main>
</div>

<script lang="ts">
	import { scale } from 'svelte/transition';
	import { m } from '$lib/paraglide/messages.js';
	import Avatar from './Avatar.svelte';
	import Icon from './Icon.svelte';
	import SelectMenu from './SelectMenu.svelte';
	import DeptRuleEditor from './DeptRuleEditor.svelte';
	import {
		addUser,
		formatLimit,
		formatTokens,
		listUsers,
		matchesProfile,
		parseTokenLimit,
		patchUser,
		removeUser,
		savePolicies,
		type AccessPolicy,
		type AdminUser,
		type CallerProfile,
		type TagUsage
	} from '$lib/admin';
	import { newId } from '$lib/id';
	import { EMPTY_MATCH } from '$lib/dept-rules';
	import type { ModelOption } from '$lib/models';
	import { getToken } from '$lib/session';
	import { providerLogo } from '$lib/providers';
	import { clickOutside } from '$lib/actions/clickOutside';
	import { placeMenu } from '$lib/floating';

	/**
	 * User management + usage statistics for admins. Lives in the organization
	 * console (/organization); every mutation applies immediately (no batch
	 * save). One instance serves both rail sections via `view`.
	 */
	let { view }: { view: 'users' | 'stats' } = $props();

	let adminUsers = $state<AdminUser[]>([]);
	let openMode = $state(false);
	let adminError = $state<string | null>(null);
	let newUsername = $state('');
	let deptUsage = $state<TagUsage[]>([]);
	let policyUsage = $state<TagUsage[]>([]);

	// --- access policies (rule-based grants; edited locally, saved as one doc) ---
	let policies = $state<AccessPolicy[]>([]);
	let policiesSaved = $state('[]');
	let you = $state<CallerProfile>({ claims: {} });
	let savingPolicies = $state(false);
	let policiesFlash = $state(false);
	const policiesDirty = $derived(JSON.stringify(policies) !== policiesSaved);

	function normalizePolicies(list: AccessPolicy[]): AccessPolicy[] {
		return list.map((p) => ({
			...p,
			match: { mode: p.match?.mode === 'all' ? 'all' : 'any', rules: p.match?.rules ?? [] },
			allowedModels: p.allowedModels ?? []
		}));
	}

	function addPolicy() {
		policies = [
			...policies,
			{
				id: newId(),
				name: '',
				enabled: true,
				match: { ...EMPTY_MATCH, rules: [] },
				role: 'user',
				allowedModels: [],
				sqlWrite: false,
				windmillWrite: false,
				maxDailyTokens: null
			}
		];
	}

	function togglePolicyModel(p: AccessPolicy, id: string) {
		const current = new Set(p.allowedModels ?? []);
		if (current.has(id)) current.delete(id);
		else current.add(id);
		p.allowedModels = [...current];
	}

	async function submitPolicies() {
		savingPolicies = true;
		const result = await savePolicies(policies);
		if (result) {
			policies = normalizePolicies(result);
			policiesSaved = JSON.stringify(policies);
			policiesFlash = true;
			setTimeout(() => (policiesFlash = false), 2000);
		}
		savingPolicies = false;
	}

	// Usage totals + per-user rows sorted by month spend, for the stats view.
	type Raw = { input: number; cacheRead: number; cacheWrite: number; output: number };
	const zeroRaw = (): Raw => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
	/** Derive total / cached / uncached (raw, un-weighted) from a breakdown. */
	function split(r?: Raw) {
		const b = r ?? zeroRaw();
		const cached = b.cacheRead + b.cacheWrite;
		return { total: b.input + b.output, cached, uncached: b.input - cached + b.output };
	}
	const usageStats = $derived.by(() => {
		const rows = [...adminUsers].sort((a, b) => b.usage.month - a.usage.month);
		const sumRaw = (pick: (u: AdminUser) => Raw | undefined) =>
			rows.reduce((acc, u) => {
				const r = pick(u) ?? zeroRaw();
				acc.input += r.input;
				acc.cacheRead += r.cacheRead;
				acc.cacheWrite += r.cacheWrite;
				acc.output += r.output;
				return acc;
			}, zeroRaw());
		return {
			rows,
			totalToday: rows.reduce((s, u) => s + u.usage.today, 0),
			totalMonth: rows.reduce((s, u) => s + u.usage.month, 0),
			maxMonth: Math.max(1, ...rows.map((u) => u.usage.month)),
			todaySplit: split(sumRaw((u) => u.usage.todayRaw)),
			monthSplit: split(sumRaw((u) => u.usage.monthRaw))
		};
	});

	// The deployment's FULL model catalog (env-defined server-side) for the
	// per-user grant popover — /api/models returns `all` for admins.
	let allModels = $state<ModelOption[]>([]);
	let defaultModel = $state('');

	async function refreshAdmin() {
		const list = await listUsers();
		if (list) {
			adminUsers = list.users;
			openMode = list.openMode;
			you = list.you;
			deptUsage = list.deptUsage;
			policyUsage = list.policyUsage;
			// Never clobber unsaved local policy edits with a background refresh.
			if (!policiesDirty) {
				policies = normalizePolicies(list.policies);
				policiesSaved = JSON.stringify(policies);
			}
		}
		try {
			const res = await fetch('/api/models', {
				headers: { Authorization: `Bearer ${getToken() ?? ''}` }
			});
			if (res.ok) {
				const data = await res.json();
				allModels = data.all ?? data.models ?? [];
				defaultModel = data.default ?? '';
			}
		} catch {
			// Non-fatal — the grant popover just shows an empty list.
		}
	}
	$effect(() => {
		void refreshAdmin();
	});

	async function runAdmin(action: () => Promise<string | null>) {
		adminError = await action();
		await refreshAdmin();
	}

	async function submitNewUser() {
		const name = newUsername.trim();
		if (!name) return;
		await runAdmin(() => addUser(name));
		if (!adminError) newUsername = '';
	}

	// Role choices for the per-user dropdown (derived so labels track locale).
	const roleOptions = $derived([
		{ value: 'user', label: m.admin_role_user() },
		{ value: 'builder', label: m.admin_role_builder() },
		{ value: 'admin', label: m.admin_role_admin() }
	]);

	// Admins implicitly get every model; other users get the default plus their
	// granted extras. The default is always on and can't be revoked.
	function modelsGranted(u: AdminUser, id: string): boolean {
		if (id === defaultModel || u.role === 'admin' || u.envAdmin) return true;
		return (u.allowedModels ?? []).includes(id);
	}
	function toggleModel(u: AdminUser, id: string) {
		if (id === defaultModel) return; // default is non-revocable
		const current = new Set(u.allowedModels ?? []);
		if (current.has(id)) current.delete(id);
		else current.add(id);
		runAdmin(() => patchUser(u.username, { allowedModels: [...current] }));
	}

	// Which user's model popover is open (one at a time), plus its trigger anchor
	// and computed fixed position (so the menu escapes the scroll box).
	let openModelsFor = $state<string | null>(null);
	let modelsAnchor = $state<HTMLElement | null>(null);
	let modelsMenuEl = $state<HTMLElement | null>(null);
	let modelsPos = $state<{ left: number; top: number; minWidth: number } | null>(null);

	$effect(() => {
		if (!openModelsFor || !modelsAnchor) {
			modelsPos = null;
			return;
		}
		const reposition = () => {
			if (!modelsAnchor) return;
			modelsPos = placeMenu(modelsAnchor.getBoundingClientRect(), modelsMenuEl?.offsetHeight ?? 0, {
				align: 'right',
				direction: 'down',
				minWidth: 240
			});
		};
		reposition();
		requestAnimationFrame(reposition);
		window.addEventListener('scroll', reposition, true);
		window.addEventListener('resize', reposition);
		return () => {
			window.removeEventListener('scroll', reposition, true);
			window.removeEventListener('resize', reposition);
		};
	});
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && (openModelsFor = null)} />

{#if view === 'stats'}
	<div class="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
		{#each [{ label: m.admin_stats_today(), s: usageStats.todaySplit, w: usageStats.totalToday }, { label: m.admin_stats_month(), s: usageStats.monthSplit, w: usageStats.totalMonth }] as card (card.label)}
			<div class="rounded-xl border border-[#e9e6dd] bg-white px-4 py-3">
				<div class="text-xs text-neutral-400">{card.label}</div>
				<div class="font-serif text-2xl font-semibold text-neutral-900">
					{formatTokens(card.s.total)}
				</div>
				<!-- cached vs uncached split of the raw tokens (2px gap between segments) -->
				<div class="mt-2 flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-[#f0eee6]">
					<div
						class="h-full rounded-full bg-[#1baf7a]"
						style="width:{Math.round((card.s.cached / Math.max(1, card.s.total)) * 100)}%"
					></div>
				</div>
				<div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-neutral-500">
					<span
						><span class="inline-block size-2 rounded-full bg-[#1baf7a] align-middle"></span>
						{m.admin_stats_cached()} {formatTokens(card.s.cached)}</span
					>
					<span
						><span class="inline-block size-2 rounded-full bg-[#d9d6c8] align-middle"></span>
						{m.admin_stats_uncached()} {formatTokens(card.s.uncached)}</span
					>
				</div>
				<div class="mt-1 text-[11px] text-neutral-400">
					{m.admin_stats_billed({ n: formatTokens(card.w) })}
				</div>
			</div>
		{/each}
	</div>
	{#if deptUsage.length > 0 || policyUsage.length > 0}
		<div class="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
			{#if deptUsage.length > 0}
				{@const deptMax = Math.max(1, ...deptUsage.map((d) => d.month))}
				<div class="rounded-xl border border-[#e9e6dd] bg-white px-4 py-3">
					<div class="mb-2 text-xs text-neutral-400">{m.admin_stats_by_dept()}</div>
					<div class="space-y-2">
						{#each deptUsage as d (d.id)}
							<div>
								<div class="flex items-baseline justify-between gap-2">
									<span class="truncate text-sm font-medium text-neutral-800">{d.name}</span>
									<span class="shrink-0 text-xs text-neutral-500">
										{m.admin_usage({ today: formatTokens(d.today ?? 0), month: formatTokens(d.month) })}
									</span>
								</div>
								<div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#f0eee6]">
									<div
										class="h-full rounded-full bg-[#d97757]"
										style="width:{Math.round((d.month / deptMax) * 100)}%"
									></div>
								</div>
							</div>
						{/each}
					</div>
					<p class="mt-2.5 text-[11px] leading-snug text-neutral-400">{m.admin_stats_multi_note()}</p>
				</div>
			{/if}
			{#if policyUsage.length > 0}
				{@const polMax = Math.max(1, ...policyUsage.map((p) => p.month))}
				<div class="rounded-xl border border-[#e9e6dd] bg-white px-4 py-3">
					<div class="mb-2 text-xs text-neutral-400">{m.admin_stats_by_policy()}</div>
					<div class="space-y-2">
						{#each policyUsage as p (p.id)}
							<div>
								<div class="flex items-baseline justify-between gap-2">
									<span class="truncate text-sm font-medium text-neutral-800">{p.name}</span>
									<span class="shrink-0 text-xs text-neutral-500">{formatTokens(p.month)}</span>
								</div>
								<div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#f0eee6]">
									<div
										class="h-full rounded-full bg-[#d97757]"
										style="width:{Math.round((p.month / polMax) * 100)}%"
									></div>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	{/if}

	{#if usageStats.rows.length === 0}
		<p class="text-sm text-neutral-400">{m.admin_stats_empty()}</p>
	{:else}
		<div class="space-y-2.5">
			{#each usageStats.rows as u (u.username)}
				<div class="flex items-center gap-3">
					<Avatar username={u.username} size={26} />
					<div class="min-w-0 flex-1">
						<div class="flex items-baseline gap-2">
							<span class="truncate text-sm font-medium text-neutral-800">{u.username}</span>
							{#if u.unlisted}
								<span
									class="shrink-0 rounded bg-[#f0eee6] px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-neutral-500 uppercase"
									title={u.policyNames?.join(', ')}
								>
									{m.admin_via_policy()}
								</span>
							{/if}
							{#each u.policyNames ?? [] as pn (pn)}
								<span class="hidden shrink-0 rounded bg-[#d97757]/8 px-1.5 py-0.5 text-[10px] font-medium text-[#bd5d3a] sm:inline">
									{pn}
								</span>
							{/each}
							<span class="min-w-0 flex-1"></span>
							<span class="shrink-0 text-xs text-neutral-500">
								{m.admin_usage({
									today: formatTokens(u.usage.today),
									month: formatTokens(u.usage.month)
								})}
							</span>
						</div>
						<div class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#f0eee6]">
							<div
								class="h-full rounded-full bg-[#d97757]"
								style="width:{Math.round((u.usage.month / usageStats.maxMonth) * 100)}%"
							></div>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
{:else}
	<!-- Rule-based grants: the same claim rules departments use, granting
	     role/models/writes/limits. Grants compose most-permissively with the
	     per-user list below; a per-user block always wins. -->
	<div class="mb-4 rounded-xl border border-[#e3e0d5] bg-white p-5">
		<div class="mb-3 flex items-start justify-between gap-3">
			<div>
				<h3 class="text-sm font-semibold text-neutral-900">{m.org_policies_title()}</h3>
				<p class="mt-0.5 text-xs text-neutral-500">{m.org_policies_hint()}</p>
			</div>
			{#if policiesFlash}
				<span class="flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-600">
					<Icon name="check" size={13} />{m.settings_saved()}
				</span>
			{:else if policiesDirty}
				<button
					onclick={submitPolicies}
					disabled={savingPolicies}
					class="shrink-0 rounded-lg bg-[#d97757] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[#bd5d3a] disabled:opacity-40"
				>
					{savingPolicies ? m.org_saving() : m.org_policies_save()}
				</button>
			{/if}
		</div>

		{#if policies.length === 0}
			<p class="mb-3 text-xs text-neutral-400">{m.org_policy_empty()}</p>
		{/if}

		<div class="space-y-3">
			{#each policies as p, pi (p.id)}
				<div class="rounded-lg border border-[#e9e6dd] bg-[#faf9f5]/60 p-3.5">
					<div class="flex items-center gap-2">
						<input
							bind:value={policies[pi].name}
							maxlength="120"
							placeholder={m.org_policy_name_placeholder()}
							class="min-w-0 flex-1 rounded-lg border border-[#e3e0d5] bg-white px-3 py-1.5 text-sm font-medium transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
						/>
						{#if matchesProfile(p.match, you)}
							<span class="shrink-0 rounded bg-[#1baf7a]/12 px-1.5 py-0.5 text-[10px] font-semibold text-[#0d8a5f]">{m.org_dept_you_badge()}</span>
						{/if}
						<button
							onclick={() => (policies[pi].enabled = !policies[pi].enabled)}
							role="switch"
							aria-checked={policies[pi].enabled}
							title={policies[pi].enabled ? m.org_dept_enabled() : m.org_dept_disabled()}
							class="relative h-5 w-9 shrink-0 rounded-full transition {policies[pi].enabled ? 'bg-[#d97757]' : 'bg-neutral-300'}"
						>
							<span class="absolute top-0.5 size-4 rounded-full bg-white transition-all {policies[pi].enabled ? 'left-4' : 'left-0.5'}"></span>
						</button>
						<button
							onclick={() => (policies = policies.filter((x) => x.id !== p.id))}
							class="shrink-0 rounded p-1 text-neutral-400 transition hover:bg-red-50 hover:text-red-600"
							title={m.org_policy_remove()}
							aria-label={m.org_policy_remove()}
						>
							<Icon name="trash" size={14} />
						</button>
					</div>

					<div class="mt-3">
						<DeptRuleEditor bind:match={policies[pi].match} you={you.claims} />
					</div>

					<!-- grants: role, extra models, write flags, daily limit -->
					<div class="mt-3 flex flex-wrap items-center gap-2 border-t border-[#efede3] pt-3">
						<SelectMenu
							options={roleOptions}
							bind:value={policies[pi].role}
							triggerClass="shrink-0"
						/>
						{#each allModels.filter((mo) => mo.id !== defaultModel) as mo (mo.id)}
							{@const on = (p.allowedModels ?? []).includes(mo.id)}
							<button
								type="button"
								onclick={() => togglePolicyModel(policies[pi], mo.id)}
								class="flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium transition {on
									? 'border-[#d97757]/40 bg-[#fdf3ef] text-[#bd5d3a]'
									: 'border-[#e3e0d5] bg-white text-neutral-400 hover:bg-[#faf9f5]'}"
							>
								<img src={providerLogo(mo.provider)} alt="" class="size-3.5 {on ? '' : 'opacity-30 grayscale'}" />
								{mo.label}
							</button>
						{/each}
						<button
							type="button"
							role="switch"
							aria-checked={p.sqlWrite === true}
							onclick={() => (policies[pi].sqlWrite = !policies[pi].sqlWrite)}
							title={m.admin_sqlwrite_title()}
							aria-label={m.admin_sqlwrite_badge()}
							class="flex shrink-0 items-center rounded-lg border px-2 py-1 transition {p.sqlWrite
								? 'border-[#d97757]/40 bg-[#fdf3ef] text-[#bd5d3a]'
								: 'border-[#e3e0d5] bg-white text-neutral-400 hover:bg-[#faf9f5]'}"
						>
							<Icon name="square-pen" size={12} />
						</button>
						<button
							type="button"
							role="switch"
							aria-checked={p.windmillWrite === true}
							onclick={() => (policies[pi].windmillWrite = !policies[pi].windmillWrite)}
							title={m.admin_wmwrite_title()}
							aria-label={m.admin_wmwrite_badge()}
							class="flex shrink-0 items-center rounded-lg border px-2 py-1 transition {p.windmillWrite
								? 'border-[#d97757]/40 bg-[#fdf3ef] text-[#bd5d3a]'
								: 'border-[#e3e0d5] bg-white text-neutral-400 hover:bg-[#faf9f5]'}"
						>
							<Icon name="zap" size={12} />
						</button>
						<input
							type="text"
							inputmode="numeric"
							value={formatLimit(p.maxDailyTokens)}
							placeholder="∞"
							title={m.admin_limit_title()}
							onchange={(e) => {
								const el = e.currentTarget;
								const parsed = parseTokenLimit(el.value);
								if (parsed === 'invalid') {
									el.classList.add('ring-2', 'ring-red-400');
									setTimeout(() => el.classList.remove('ring-2', 'ring-red-400'), 1200);
									el.value = formatLimit(p.maxDailyTokens);
									return;
								}
								el.value = formatLimit(parsed);
								policies[pi].maxDailyTokens = parsed;
							}}
							class="w-24 shrink-0 rounded-lg border border-[#e3e0d5] bg-white px-2 py-1 text-right text-xs text-neutral-600 transition focus:border-[#d97757] focus:outline-none"
						/>
					</div>
				</div>
			{/each}
		</div>

		<button
			onclick={addPolicy}
			class="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[#d8d4c6] px-3 py-2 text-sm font-medium text-neutral-500 transition hover:border-[#d97757]/50 hover:bg-[#d97757]/5 hover:text-[#bd5d3a]"
		>
			<Icon name="plus" size={15} />
			{m.org_policy_add()}
		</button>
	</div>

	<div class="rounded-xl border border-[#e3e0d5] bg-white p-5">
	{#if openMode}
		<p class="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
			{m.admin_open_mode()}
		</p>
	{/if}
	{#if adminError}
		<p class="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{adminError}</p>
	{/if}

	<div class="flex gap-2">
		<input
			type="text"
			bind:value={newUsername}
			onkeydown={(e) => e.key === 'Enter' && submitNewUser()}
			placeholder={m.admin_add_placeholder()}
			class="min-w-0 flex-1 rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
		/>
		<button
			onclick={submitNewUser}
			disabled={!newUsername.trim()}
			class="shrink-0 rounded-xl bg-[#d97757] px-3.5 py-2 text-sm font-medium text-white transition hover:bg-[#bd5d3a] disabled:opacity-40"
		>
			{m.admin_add()}
		</button>
	</div>

	<div class="mt-2">
		{#each adminUsers as u (u.username)}
			<div class="border-b border-[#efede3] py-2.5 last:border-b-0 last:pb-0">
				<div class="flex items-center gap-2.5">
					<Avatar username={u.username} size={26} />
					<span class="min-w-0 flex-1 truncate text-sm font-medium text-neutral-800">
						{u.username}
					</span>
					{#if u.envAdmin}
						<span
							class="shrink-0 rounded bg-[#f0eee6] px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-neutral-500 uppercase"
							title={m.admin_env_badge_hint()}
						>
							{m.admin_env_badge()}
						</span>
					{/if}
					{#if u.unlisted}
						<span
							class="shrink-0 rounded bg-[#f0eee6] px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-neutral-500 uppercase"
							title={u.policyNames?.join(', ')}
						>
							{m.admin_via_policy()}
						</span>
					{/if}
					{#if u.blocked}
						<span
							class="shrink-0 rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-red-600 uppercase"
						>
							{m.admin_blocked_badge()}
						</span>
					{/if}
				</div>
				<div class="mt-2 flex flex-wrap items-center gap-2 sm:pl-[34px]">
					<SelectMenu
						options={roleOptions}
						value={u.role}
						disabled={u.envAdmin}
						triggerClass="shrink-0"
						onSelect={(role) =>
							runAdmin(() => patchUser(u.username, { role: role as 'admin' | 'builder' | 'user' }))}
					/>

					<!-- Per-user model allow-list. Admins implicitly get all (shown
					     as read-only ticks); the default model is always granted.
					     Closes on click-away / Escape. -->
					<div
						class="relative shrink-0"
						use:clickOutside={{
							enabled: () => openModelsFor === u.username,
							onOutside: () => (openModelsFor = null)
						}}
					>
						<button
							type="button"
							onclick={(e) => {
								if (openModelsFor === u.username) {
									openModelsFor = null;
								} else {
									openModelsFor = u.username;
									modelsAnchor = e.currentTarget;
								}
							}}
							title={m.admin_models_title()}
							aria-haspopup="true"
							aria-expanded={openModelsFor === u.username}
							class="flex items-center gap-1.5 rounded-lg border bg-white px-2 py-1 text-xs font-medium text-neutral-600 transition hover:bg-[#faf9f5] {openModelsFor ===
							u.username
								? 'border-[#d97757]/40'
								: 'border-[#e3e0d5]'}"
						>
							<Icon name="sparkle" size={12} class="text-[#bd5d3a]" />
							{allModels.filter((mo) => modelsGranted(u, mo.id)).length}
							<Icon
								name="chevron-down"
								size={11}
								class="text-neutral-400 transition-transform {openModelsFor === u.username
									? 'rotate-180'
									: ''}"
							/>
						</button>
						{#if openModelsFor === u.username}
							<div
								bind:this={modelsMenuEl}
								in:scale={{ duration: 130, start: 0.95, opacity: 0 }}
								style="position:fixed; left:{modelsPos?.left ?? 0}px; top:{modelsPos?.top ??
									0}px; min-width:{modelsPos?.minWidth ?? 240}px; transform-origin:top right; visibility:{modelsPos
									? 'visible'
									: 'hidden'}"
								class="z-50 overflow-hidden rounded-2xl border border-[#e3e0d5] bg-white p-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.07)]"
							>
								{#each allModels as mo (mo.id)}
									{@const locked = mo.id === defaultModel || u.role === 'admin' || u.envAdmin}
									{@const on = modelsGranted(u, mo.id)}
									<button
										type="button"
										disabled={locked}
										onclick={() => toggleModel(u, mo.id)}
										class="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition {locked
											? 'cursor-default'
											: 'hover:bg-[#faf9f5]'}"
									>
										<img
											src={providerLogo(mo.provider)}
											alt=""
											class="size-4 shrink-0 {on ? '' : 'opacity-30 grayscale'}"
										/>
										<span class="flex-1 text-sm font-medium {on ? 'text-neutral-800' : 'text-neutral-400'}">
											{mo.label}
										</span>
										{#if mo.id === defaultModel}
											<span class="text-[10px] tracking-wide text-neutral-400 uppercase"
												>{m.admin_models_default()}</span
											>
										{/if}
										<span
											class="grid size-4 shrink-0 place-items-center rounded-md border transition {on
												? 'border-[#d97757] bg-[#d97757] text-white'
												: 'border-[#d9d6c8] bg-white'}"
										>
											{#if on}<Icon name="check" size={11} />{/if}
										</span>
									</button>
								{/each}
							</div>
						{/if}
					</div>

					<!-- Warehouse write grant. Off by default, and not implied by the
					     admin role: StarRocks already authorizes every statement against
					     this user's own grants, so this only decides whether the MODEL
					     may compose a write under them. -->
					<button
						type="button"
						role="switch"
						aria-checked={u.sqlWrite === true}
						onclick={() => runAdmin(() => patchUser(u.username, { sqlWrite: !u.sqlWrite }))}
						title={m.admin_sqlwrite_title()}
						aria-label={m.admin_sqlwrite_badge()}
						class="flex shrink-0 items-center rounded-lg border px-2 py-1 transition {u.sqlWrite
							? 'border-[#d97757]/40 bg-[#fdf3ef] text-[#bd5d3a]'
							: 'border-[#e3e0d5] bg-white text-neutral-400 hover:bg-[#faf9f5]'}"
					>
						<Icon name="square-pen" size={12} />
					</button>

					<!-- Windmill workspace write grant. Off by default; reading and
					     running scripts/flows works without it. -->
					<button
						type="button"
						role="switch"
						aria-checked={u.windmillWrite === true}
						onclick={() => runAdmin(() => patchUser(u.username, { windmillWrite: !u.windmillWrite }))}
						title={m.admin_wmwrite_title()}
						aria-label={m.admin_wmwrite_badge()}
						class="flex shrink-0 items-center rounded-lg border px-2 py-1 transition {u.windmillWrite
							? 'border-[#d97757]/40 bg-[#fdf3ef] text-[#bd5d3a]'
							: 'border-[#e3e0d5] bg-white text-neutral-400 hover:bg-[#faf9f5]'}"
					>
						<Icon name="zap" size={12} />
					</button>

					<input
						type="text"
						inputmode="numeric"
						value={formatLimit(u.maxDailyTokens)}
						placeholder="∞"
						title={m.admin_limit_title()}
						onchange={(e) => {
							const el = e.currentTarget;
							const parsed = parseTokenLimit(el.value);
							if (parsed === 'invalid') {
								el.classList.add('ring-2', 'ring-red-400');
								setTimeout(() => el.classList.remove('ring-2', 'ring-red-400'), 1200);
								el.value = formatLimit(u.maxDailyTokens);
								return;
							}
							el.value = formatLimit(parsed);
							runAdmin(() => patchUser(u.username, { maxDailyTokens: parsed }));
						}}
						class="w-28 shrink-0 rounded-lg border border-[#e3e0d5] bg-white px-2 py-1 text-right text-xs text-neutral-600 transition focus:border-[#d97757] focus:outline-none"
					/>

					<button
						role="switch"
						aria-checked={!u.blocked}
						disabled={u.envAdmin}
						onclick={() => runAdmin(() => patchUser(u.username, { blocked: !u.blocked }))}
						title={u.blocked ? m.admin_unblock() : m.admin_block()}
						class="relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40
							{u.blocked ? 'bg-[#d9d6c8]' : 'bg-[#1baf7a]'}"
					>
						<span
							class="absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform duration-200
								{u.blocked ? 'translate-x-0' : 'translate-x-4'}"
						></span>
					</button>

					<button
						onclick={() => runAdmin(() => removeUser(u.username))}
						disabled={u.envAdmin}
						class="shrink-0 rounded p-1 text-neutral-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
						title={m.admin_remove()}
						aria-label={m.admin_remove()}
					>
						<Icon name="trash" size={14} />
					</button>
				</div>
			</div>
		{/each}
	</div>
	</div>
{/if}

<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale, setLocale } from '$lib/paraglide/runtime';
	import Avatar from './Avatar.svelte';
	import Icon from './Icon.svelte';
	import SelectMenu from './SelectMenu.svelte';
	import { saveSettings, type PublicSettings } from '$lib/settings';
	import { goto } from '$app/navigation';
	import {
		addUser,
		formatLimit,
		formatTokens,
		listUsers,
		parseTokenLimit,
		patchUser,
		removeUser,
		type AdminUser
	} from '$lib/admin';
	import MemoryManager from './MemoryManager.svelte';
	import type { ModelOption } from '$lib/models';
	import { getToken } from '$lib/session';
	import { providerLogo } from '$lib/providers';
	import { clickOutside } from '$lib/actions/clickOutside';
	import { placeMenu } from '$lib/floating';

	// Which user's model popover is open (one at a time), plus its trigger anchor
	// and computed fixed position (so the menu escapes the modal's scroll box).
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

	let {
		username,
		settings,
		onClose,
		onSaved
	}: {
		/** Login username — seeds the identicon, immutable. */
		username: string;
		settings: PublicSettings;
		onClose: () => void;
		onSaved: (updated: PublicSettings) => void;
	} = $props();

	type Section = 'general' | 'memory' | 'connectors' | 'admin';
	let section = $state<Section>('general');

	// --- admin panel state (loaded lazily when the section opens) ---
	let adminUsers = $state<AdminUser[]>([]);
	let openMode = $state(false);
	let adminLoaded = $state(false);
	let adminTab = $state<'users' | 'stats'>('users');

	// Usage totals + per-user rows sorted by month spend, for the stats tab.
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
	let adminError = $state<string | null>(null);
	let newUsername = $state('');

	// The deployment's FULL model catalog (env-defined server-side) for the
	// per-user grant popover — /api/models returns `all` for admins.
	let allModels = $state<ModelOption[]>([]);
	let defaultModel = $state('');

	async function refreshAdmin() {
		const list = await listUsers();
		if (list) {
			adminUsers = list.users;
			openMode = list.openMode;
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
		adminLoaded = true;
	}
	$effect(() => {
		if (section === 'admin' && !adminLoaded) void refreshAdmin();
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

	// Local drafts — committed only on Save. The modal is remounted on every
	// open, so capturing the initial settings once is intended.
	// svelte-ignore state_referenced_locally
	let fullName = $state(settings.fullName);
	// svelte-ignore state_referenced_locally
	let displayName = $state(settings.displayName);
	// svelte-ignore state_referenced_locally
	let systemPrompt = $state(settings.systemPrompt);
	let windmillToken = $state('');
	// svelte-ignore state_referenced_locally
	let tokenSet = $state(settings.windmillTokenSet);
	let removeToken = $state(false);
	let tabulaToken = $state('');
	// svelte-ignore state_referenced_locally
	let tabulaTokenSet = $state(settings.tabulaTokenSet);
	let removeTabulaToken = $state(false);
	// svelte-ignore state_referenced_locally
	let webSearch = $state(settings.webSearch);
	// svelte-ignore state_referenced_locally
	let memoryEnabled = $state(settings.memoryEnabled);

	// The memory on/off toggle lives on its own pane and persists immediately
	// (the topic list, in MemoryManager, manages itself), so it is NOT part of
	// the general Save flow.
	async function toggleMemory() {
		memoryEnabled = !memoryEnabled;
		const updated = await saveSettings({ memoryEnabled });
		if (updated) onSaved(updated);
	}

	let saving = $state(false);
	let savedFlash = $state(false);
	let saveError = $state(false);

	const dirty = $derived(
		fullName !== settings.fullName ||
			displayName !== settings.displayName ||
			systemPrompt !== settings.systemPrompt ||
			webSearch !== settings.webSearch ||
			windmillToken.trim() !== '' ||
			removeToken ||
			tabulaToken.trim() !== '' ||
			removeTabulaToken
	);

	async function save() {
		if (saving || !dirty) return;
		saving = true;
		saveError = false;
		const updated = await saveSettings({
			fullName,
			displayName,
			systemPrompt,
			webSearch,
			...(removeToken
				? { windmillToken: null }
				: windmillToken.trim()
					? { windmillToken: windmillToken.trim() }
					: {}),
			...(removeTabulaToken
				? { tabulaToken: null }
				: tabulaToken.trim()
					? { tabulaToken: tabulaToken.trim() }
					: {})
		});
		saving = false;
		if (!updated) {
			saveError = true;
			return;
		}
		windmillToken = '';
		removeToken = false;
		tokenSet = updated.windmillTokenSet;
		tabulaToken = '';
		removeTabulaToken = false;
		tabulaTokenSet = updated.tabulaTokenSet;
		onSaved(updated);
		savedFlash = true;
		setTimeout(() => (savedFlash = false), 2000);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		// Escape closes an open model popover first, then the modal.
		if (openModelsFor) openModelsFor = null;
		else onClose();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-4"
	transition:fade={{ duration: 150 }}
	onclick={(e) => e.target === e.currentTarget && onClose()}
	role="presentation"
>
	<div
		transition:scale={{ start: 0.96, duration: 180 }}
		class="flex h-[600px] max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl sm:max-h-[85vh] sm:flex-row"
		role="dialog"
		aria-modal="true"
		aria-label={m.settings_title()}
	>
		<!-- Section nav — a scrollable tab strip on phones, a sidebar from sm up.
		     The wrapper collapses (display:contents) at sm so the nav becomes a
		     direct flex child of the dialog again. -->
		<div class="flex shrink-0 items-center border-b border-[#e3e0d5] bg-[#f0eee6] sm:contents">
			<nav
				class="flex min-w-0 flex-1 gap-1 overflow-x-auto p-2 sm:w-44 sm:flex-none sm:flex-col sm:gap-0.5 sm:overflow-x-visible sm:border-r sm:border-[#e3e0d5] sm:bg-[#f0eee6] sm:p-3 md:w-52"
			>
				<span
					class="hidden px-2 pt-1 pb-2 text-xs font-semibold tracking-wide text-neutral-500 uppercase sm:block"
				>
					{m.settings_title()}
				</span>
				{#each [{ id: 'general', icon: 'settings', label: m.settings_general() }, { id: 'memory', icon: 'sparkle', label: m.settings_memory() }, { id: 'connectors', icon: 'zap', label: m.settings_connectors() }, ...(settings.role === 'admin' ? [{ id: 'admin', icon: 'users', label: m.admin_title() }] : [])] as item (item.id)}
					<button
						onclick={() => (section = item.id as Section)}
						class="flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm whitespace-nowrap transition
							{section === item.id
							? 'bg-white font-medium text-neutral-900 shadow-sm'
							: 'text-neutral-600 hover:bg-white/60'}"
					>
						<Icon name={item.icon as 'settings' | 'sparkle' | 'zap' | 'users'} size={16} />
						{item.label}
					</button>
				{/each}
			</nav>
			<button
				onclick={onClose}
				class="mr-1 shrink-0 rounded-lg p-2 text-neutral-500 transition hover:bg-white/70 hover:text-neutral-700 sm:hidden"
				title={m.settings_close()}
				aria-label={m.settings_close()}
			>
				<Icon name="x" size={18} />
			</button>
		</div>

		<!-- Content -->
		<div class="flex min-h-0 min-w-0 flex-1 flex-col">
			<div class="hidden items-center justify-end px-4 pt-3 sm:flex">
				<button
					onclick={onClose}
					class="rounded-lg p-2 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
					title={m.settings_close()}
					aria-label={m.settings_close()}
				>
					<Icon name="x" size={18} />
				</button>
			</div>

			<div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pt-4 pb-4 sm:px-7 sm:pt-0">
				{#if section === 'general'}
					<h2 class="font-serif text-xl font-semibold text-neutral-900">{m.settings_profile()}</h2>

					<div class="mt-4 flex items-center justify-between border-b border-[#efede3] pb-4">
						<span class="text-sm font-medium text-neutral-700">{m.settings_avatar()}</span>
						<Avatar {username} size={40} />
					</div>

					<div
						class="flex flex-col gap-2 border-b border-[#efede3] py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
					>
						<label for="set-fullname" class="text-sm font-medium text-neutral-700">
							{m.settings_full_name()}
						</label>
						<input
							id="set-fullname"
							type="text"
							bind:value={fullName}
							maxlength="80"
							class="w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none sm:w-56"
						/>
					</div>

					<div
						class="flex flex-col gap-2 border-b border-[#efede3] py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
					>
						<label for="set-displayname" class="text-sm font-medium text-neutral-700">
							{m.settings_call_you()}
						</label>
						<input
							id="set-displayname"
							type="text"
							bind:value={displayName}
							maxlength="80"
							class="w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none sm:w-56"
						/>
					</div>

					<div class="border-b border-[#efede3] py-4">
						<label for="set-instructions" class="text-sm font-medium text-neutral-700">
							{m.settings_instructions()}
						</label>
						<p class="mt-0.5 mb-2 text-xs text-neutral-500">{m.settings_instructions_hint()}</p>
						<textarea
							id="set-instructions"
							bind:value={systemPrompt}
							maxlength="4000"
							rows="4"
							placeholder={m.settings_instructions_placeholder()}
							class="w-full resize-none rounded-xl border border-neutral-300 px-3 py-2.5 text-sm transition placeholder:text-neutral-400 focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
						></textarea>
					</div>

					<h2 class="mt-5 font-serif text-xl font-semibold text-neutral-900">
						{m.settings_preferences()}
					</h2>
					{#if settings.webSearchAvailable}
						<div
							class="flex items-center justify-between gap-4 border-b border-[#efede3] py-4 sm:gap-6"
						>
							<span class="min-w-0">
								<span class="block text-sm font-medium text-neutral-700">{m.settings_web_search()}</span>
								<span class="mt-0.5 block text-xs text-neutral-500">{m.settings_web_search_hint()}</span>
							</span>
							<button
								role="switch"
								aria-checked={webSearch}
								aria-label={m.settings_web_search()}
								onclick={() => (webSearch = !webSearch)}
								class="relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200
									{webSearch ? 'bg-[#d97757]' : 'bg-[#d9d6c8]'}"
							>
								<span
									class="absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200
										{webSearch ? 'translate-x-5' : 'translate-x-0'}"
								></span>
							</button>
						</div>
					{/if}
					<div class="flex items-center justify-between py-4">
						<span class="text-sm font-medium text-neutral-700">{m.settings_language()}</span>
						<div class="flex rounded-lg border border-[#e3e0d5] p-0.5">
							{#each [{ locale: 'pt-br', label: 'PT' }, { locale: 'en', label: 'EN' }] as opt (opt.locale)}
								<button
									onclick={() => getLocale() !== opt.locale && setLocale(opt.locale as 'pt-br' | 'en')}
									class="rounded-md px-3 py-1 text-xs font-semibold transition
										{getLocale() === opt.locale
										? 'bg-[#d97757] text-white'
										: 'text-neutral-500 hover:text-neutral-800'}"
								>
									{opt.label}
								</button>
							{/each}
						</div>
					</div>
				{:else if section === 'memory'}
					<h2 class="font-serif text-xl font-semibold text-neutral-900">{m.settings_memory()}</h2>
					<p class="mt-1.5 max-w-xl text-sm leading-relaxed text-neutral-500">
						{m.settings_memory_hint()}
					</p>

					<div
						class="mt-5 flex items-center justify-between gap-4 border-b border-[#efede3] pb-5 sm:gap-6"
					>
						<span class="text-sm font-medium text-neutral-700">{m.settings_memory_toggle()}</span>
						<button
							role="switch"
							aria-checked={memoryEnabled}
							aria-label={m.settings_memory_toggle()}
							onclick={toggleMemory}
							class="relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200
								{memoryEnabled ? 'bg-[#d97757]' : 'bg-[#d9d6c8]'}"
						>
							<span
								class="absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200
									{memoryEnabled ? 'translate-x-5' : 'translate-x-0'}"
							></span>
						</button>
					</div>

					<div class="mt-5">
						<MemoryManager />
					</div>
				{:else if section === 'connectors'}
					<h2 class="font-serif text-xl font-semibold text-neutral-900">Windmill</h2>
					<p class="mt-1.5 text-sm leading-relaxed text-neutral-500">
						{m.settings_windmill_desc()}
					</p>
					<p class="mt-1 text-xs text-neutral-400">{m.settings_windmill_hint()}</p>

					<div class="mt-5 flex items-center gap-2 text-sm">
						<span
							class="size-2 rounded-full {tokenSet && !removeToken
								? 'bg-emerald-500'
								: 'bg-neutral-300'}"
						></span>
						<span class="text-neutral-600">
							{tokenSet && !removeToken ? m.settings_windmill_set() : m.settings_windmill_unset()}
						</span>
					</div>

					<div class="mt-3">
						<label for="set-windmill" class="mb-1.5 block text-sm font-medium text-neutral-700">
							{m.settings_windmill_token()}
						</label>
						<input
							id="set-windmill"
							type="password"
							bind:value={windmillToken}
							oninput={() => (removeToken = false)}
							maxlength="200"
							autocomplete="off"
							placeholder={tokenSet ? m.settings_windmill_placeholder_set() : ''}
							class="w-full rounded-xl border border-neutral-300 px-3 py-2.5 font-mono text-sm transition placeholder:font-sans placeholder:text-neutral-400 focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
						/>
					</div>

					{#if tokenSet}
						<button
							onclick={() => {
								removeToken = !removeToken;
								if (removeToken) windmillToken = '';
							}}
							class="mt-3 rounded-lg px-2.5 py-1.5 text-xs font-medium transition
								{removeToken
								? 'bg-red-50 text-red-700'
								: 'text-red-600 hover:bg-red-50'}"
						>
							{removeToken ? `✓ ${m.settings_windmill_remove()}` : m.settings_windmill_remove()}
						</button>
					{/if}

					<div class="mt-6 border-t border-neutral-200 pt-5">
						<p class="text-sm leading-relaxed text-neutral-500">{m.settings_tabula_desc()}</p>
						<p class="mt-1 text-xs text-neutral-400">{m.settings_tabula_hint()}</p>

						<div class="mt-4 flex items-center gap-2 text-sm">
							<span
								class="size-2 rounded-full {tabulaTokenSet && !removeTabulaToken
									? 'bg-emerald-500'
									: 'bg-neutral-300'}"
							></span>
							<span class="text-neutral-600">
								{tabulaTokenSet && !removeTabulaToken ? m.settings_tabula_set() : m.settings_tabula_unset()}
							</span>
						</div>

						<div class="mt-3">
							<label for="set-tabula" class="mb-1.5 block text-sm font-medium text-neutral-700">
								{m.settings_tabula_token()}
							</label>
							<input
								id="set-tabula"
								type="password"
								bind:value={tabulaToken}
								oninput={() => (removeTabulaToken = false)}
								maxlength="200"
								autocomplete="off"
								placeholder={tabulaTokenSet ? m.settings_windmill_placeholder_set() : ''}
								class="w-full rounded-xl border border-neutral-300 px-3 py-2.5 font-mono text-sm transition placeholder:font-sans placeholder:text-neutral-400 focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
							/>
						</div>

						{#if tabulaTokenSet}
							<button
								onclick={() => {
									removeTabulaToken = !removeTabulaToken;
									if (removeTabulaToken) tabulaToken = '';
								}}
								class="mt-3 rounded-lg px-2.5 py-1.5 text-xs font-medium transition
									{removeTabulaToken
									? 'bg-red-50 text-red-700'
									: 'text-red-600 hover:bg-red-50'}"
							>
								{removeTabulaToken ? `✓ ${m.settings_tabula_remove()}` : m.settings_tabula_remove()}
							</button>
						{/if}
					</div>
				{:else}
					<button
						onclick={() => goto('/organization')}
						class="group flex w-full items-center gap-3 rounded-xl border border-neutral-200 bg-[#faf9f5] px-4 py-3 text-left transition hover:border-[#d97757]/40 hover:bg-[#d97757]/5"
					>
						<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-[#d97757]/12 text-[#bd5d3a]">
							<Icon name="book" size={16} />
						</span>
						<span class="min-w-0 flex-1">
							<span class="block text-sm font-semibold text-neutral-900">{m.admin_org_console()}</span>
							<span class="block text-xs text-neutral-500">{m.admin_org_console_hint()}</span>
						</span>
						<Icon name="arrow-right" size={16} class="shrink-0 text-neutral-400 transition group-hover:text-[#bd5d3a]" />
					</button>

					<div class="mt-6 flex gap-1 border-b border-[#e9e6dd]">
						{#each [{ id: 'users', label: m.admin_users_title() }, { id: 'stats', label: m.admin_stats_tab() }] as tab (tab.id)}
							<button
								onclick={() => (adminTab = tab.id as 'users' | 'stats')}
								class="-mb-px border-b-2 px-3 py-2 text-sm font-medium transition {adminTab === tab.id
									? 'border-[#d97757] text-neutral-900'
									: 'border-transparent text-neutral-500 hover:text-neutral-800'}"
							>
								{tab.label}
							</button>
						{/each}
					</div>

					{#if adminTab === 'stats'}
						<!-- STATISTICS TAB -->
						<div class="mt-4 mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
							{#each [{ label: m.admin_stats_today(), s: usageStats.todaySplit, w: usageStats.totalToday }, { label: m.admin_stats_month(), s: usageStats.monthSplit, w: usageStats.totalMonth }] as card (card.label)}
								<div class="rounded-xl border border-[#e9e6dd] bg-[#faf9f5] px-4 py-3">
									<div class="text-xs text-neutral-400">{card.label}</div>
									<div class="font-serif text-2xl font-semibold text-neutral-900">
										{formatTokens(card.s.total)}
									</div>
									<!-- cached vs uncached split of the raw tokens -->
									<div class="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-[#f0eee6]">
										<div
											class="h-full bg-[#1baf7a]"
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
						{#if usageStats.rows.length === 0}
							<p class="text-sm text-neutral-400">{m.admin_stats_empty()}</p>
						{:else}
							<div class="space-y-2.5">
								{#each usageStats.rows as u (u.username)}
									<div class="flex items-center gap-3">
										<Avatar username={u.username} size={26} />
										<div class="min-w-0 flex-1">
											<div class="flex items-baseline justify-between gap-2">
												<span class="truncate text-sm font-medium text-neutral-800">{u.username}</span>
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
					{#if openMode}
						<p class="mt-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
							{m.admin_open_mode()}
						</p>
					{/if}
					{#if adminError}
						<p class="mt-1 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{adminError}</p>
					{/if}

					<div class="mt-3 flex gap-2">
						<input
							type="text"
							bind:value={newUsername}
							onkeydown={(e) => e.key === 'Enter' && submitNewUser()}
							placeholder={m.admin_add_placeholder()}
							class="min-w-0 flex-1 rounded-xl border border-neutral-300 px-3 py-2 text-sm transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
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
							<div class="border-b border-[#efede3] py-2.5">
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
										runAdmin(() =>
											patchUser(u.username, { role: role as 'admin' | 'builder' | 'user' })
										)}
								/>

								<!-- Per-user model allow-list. Admins implicitly get all (shown
								     as read-only ticks); the default model is always granted.
								     Closes on click-away / Escape (see onKeydown). -->
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
											class="text-neutral-400 transition-transform {openModelsFor === u.username ? 'rotate-180' : ''}"
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
											class="z-50 overflow-hidden rounded-2xl border border-[#e3e0d5] bg-white p-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.12)]"
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
									onclick={() =>
										runAdmin(() => patchUser(u.username, { windmillWrite: !u.windmillWrite }))}
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
					{/if}
				{/if}
			</div>

			<!-- Footer (admin + memory apply immediately — no batch save there) -->
			<div
				class="flex shrink-0 items-center justify-end gap-3 border-t border-[#efede3] px-4 py-3.5 sm:px-7
					{section === 'admin' || section === 'memory' ? 'invisible' : ''}"
			>
				{#if saveError}
					<span class="text-sm text-red-600">{m.settings_save_failed()}</span>
				{:else if savedFlash}
					<span class="flex items-center gap-1.5 text-sm text-emerald-600" transition:fade>
						<Icon name="check" size={14} />
						{m.settings_saved()}
					</span>
				{/if}
				<button
					onclick={save}
					disabled={!dirty || saving}
					class="rounded-xl bg-[#d97757] px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-[#bd5d3a] disabled:opacity-40"
				>
					{m.settings_save()}
				</button>
			</div>
		</div>
	</div>
</div>

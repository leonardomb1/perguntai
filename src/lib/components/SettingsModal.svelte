<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale, setLocale } from '$lib/paraglide/runtime';
	import Avatar from './Avatar.svelte';
	import Icon from './Icon.svelte';
	import TokenField from './TokenField.svelte';
	import SelectMenu from './SelectMenu.svelte';
	import { saveSettings, type PublicSettings } from '$lib/settings';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import MemoryManager from './MemoryManager.svelte';
	import { getToken } from '$lib/session';
	import { copyText } from '$lib/clipboard';
	import {
		createKey,
		isExpired,
		listKeys,
		revokeKey,
		type PublicApiKey
	} from '$lib/apiKeys';
	let {
		username,
		settings,
		onClose,
		onSaved,
		initial = 'general'
	}: {
		/** Login username — seeds the identicon, immutable. */
		username: string;
		settings: PublicSettings;
		onClose: () => void;
		onSaved: (updated: PublicSettings) => void;
		/** Section to open on — lets in-app notices deep-link (e.g. connectors). */
		initial?: 'general' | 'memory' | 'connectors' | 'apikeys';
	} = $props();

	type Section = 'general' | 'memory' | 'connectors' | 'apikeys';
	// svelte-ignore state_referenced_locally
	let section = $state<Section>(initial);

	// --- personal API keys (loaded lazily when the section opens) ---
	let keys = $state<PublicApiKey[]>([]);
	let keysLoaded = $state(false);
	let keyLabel = $state('');
	let keyExpiry = $state('90'); // days; '0' = no expiry (90 is the nudged default)
	let keyScope = $state<'chat' | 'full'>('chat');
	let creatingKey = $state(false);
	let keyError = $state(false);
	/** Plaintext of the key just minted — the server never returns it again. */
	let freshKey = $state<string | null>(null);
	let freshCopied = $state(false);
	let confirmRevoke = $state<string | null>(null);

	// OpenAI-compatible surface: any openai SDK / LangChain / Open WebUI works
	// by pointing base_url here. Built in the script so JSON braces need no
	// template escaping.
	const curlExample = [
		`curl ${browser ? location.origin : ''}/v1/chat/completions \\`,
		'  -H "Authorization: Bearer pai_…" \\',
		'  -H "Content-Type: application/json" \\',
		`  -d '{"model":"", "messages":[{"role":"user","content":"Olá"}]}'`
	].join('\n');
	const pythonExample = [
		'from openai import OpenAI',
		`client = OpenAI(base_url="${browser ? location.origin : ''}/v1", api_key="pai_…")`,
		'r = client.chat.completions.create(model="", messages=[{"role": "user", "content": "Olá"}])'
	].join('\n');
	const scopeOptions = $derived([
		{ value: 'chat', label: m.apikeys_scope_chat(), hint: m.apikeys_scope_chat_hint() },
		{ value: 'full', label: m.apikeys_scope_full(), hint: m.apikeys_scope_full_hint() }
	]);

	const expiryOptions = $derived([
		{ value: '30', label: m.apikeys_expiry_days({ n: 30 }) },
		{ value: '90', label: m.apikeys_expiry_days({ n: 90 }) },
		{ value: '365', label: m.apikeys_expiry_days({ n: 365 }) },
		{ value: '0', label: m.apikeys_expiry_never() }
	]);

	async function refreshKeys() {
		const list = await listKeys();
		if (list) keys = list;
		keysLoaded = true;
	}
	$effect(() => {
		if (section === 'apikeys' && !keysLoaded) void refreshKeys();
	});

	async function submitNewKey() {
		if (creatingKey) return;
		creatingKey = true;
		keyError = false;
		const days = Number(keyExpiry);
		const result = await createKey(keyLabel.trim(), days > 0 ? days : undefined, keyScope);
		creatingKey = false;
		if (!result.ok) {
			keyError = true;
			return;
		}
		// Shown once, right here — there is no second chance to read it.
		freshKey = result.key;
		freshCopied = false;
		keyLabel = '';
		await refreshKeys();
	}

	async function copyFreshKey() {
		if (!freshKey) return;
		freshCopied = await copyText(freshKey);
	}

	async function doRevoke(id: string) {
		confirmRevoke = null;
		keyError = false;
		if (await revokeKey(id)) await refreshKeys();
		else keyError = true;
	}

	/** Short, locale-aware date for the key list. */
	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString(getLocale() === 'en' ? 'en-US' : 'pt-BR', {
			day: '2-digit',
			month: 'short',
			year: 'numeric'
		});
	}

	// Local drafts — committed only on Save. The modal is remounted on every
	// open, so capturing the initial settings once is intended.
	// svelte-ignore state_referenced_locally
	let fullName = $state(settings.fullName);
	// svelte-ignore state_referenced_locally
	let displayName = $state(settings.displayName);
	// svelte-ignore state_referenced_locally
	let systemPrompt = $state(settings.systemPrompt);

	// On-demand MCP servers. Each row edits in place; `token` is write-only
	// (empty = keep the stored one, which `tokenSet` reports).
	type McpRow = {
		id?: string;
		name: string;
		url: string;
		token: string;
		tokenSet: boolean;
		removeToken: boolean;
		enabled: boolean;
	};
	const rowsFrom = (list: typeof settings.mcpServers): McpRow[] =>
		list.map((sv) => ({
			id: sv.id,
			name: sv.name,
			url: sv.url,
			token: '',
			tokenSet: sv.tokenSet,
			removeToken: false,
			enabled: sv.enabled
		}));
	// svelte-ignore state_referenced_locally
	let mcpRows = $state<McpRow[]>(rowsFrom(settings.mcpServers));
	const mcpSnapshot = (rows: McpRow[]) =>
		JSON.stringify(rows.map((r) => [r.id, r.name, r.url, r.token, r.removeToken, r.enabled]));
	// svelte-ignore state_referenced_locally
	let mcpSaved = $state(mcpSnapshot(rowsFrom(settings.mcpServers)));
	function addMcpRow() {
		if (mcpRows.length >= 5) return;
		mcpRows = [...mcpRows, { name: '', url: '', token: '', tokenSet: false, removeToken: false, enabled: true }];
	}
	function removeMcpRow(i: number) {
		mcpRows = mcpRows.filter((_, idx) => idx !== i);
	}

	// Connection tests, keyed by server row (id, or index for unsaved rows).
	type TestState = { busy: boolean; ok?: boolean; detail?: string };
	let tests = $state<Record<string, TestState>>({});
	async function testConnector(key: string, body: Record<string, unknown>) {
		tests[key] = { busy: true };
		try {
			const res = await fetch('/api/settings/mcp-test', {
				method: 'POST',
				headers: { Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			const data = (await res.json()) as { ok?: boolean; tools?: string[]; error?: string };
			tests[key] = data.ok
				? {
						busy: false,
						ok: true,
						detail: m.settings_mcp_test_ok({ count: data.tools?.length ?? 0 }) +
							(data.tools?.length ? ` — ${data.tools.slice(0, 5).join(', ')}${data.tools.length > 5 ? '…' : ''}` : '')
					}
				: { busy: false, ok: false, detail: data.error ?? 'error' };
		} catch {
			tests[key] = { busy: false, ok: false, detail: m.settings_mcp_test_unreachable() };
		}
	}
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
	/** Bumped on save so every TokenField resets its local editing state. */
	let saveGen = $state(0);
	let savedFlash = $state(false);
	let saveError = $state(false);

	const dirty = $derived(
		fullName !== settings.fullName ||
			displayName !== settings.displayName ||
			systemPrompt !== settings.systemPrompt ||
			webSearch !== settings.webSearch ||
			mcpSnapshot(mcpRows) !== mcpSaved
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
			mcpServers: mcpRows
				.filter((r) => r.name.trim() && r.url.trim())
				.map((r) => ({
					...(r.id ? { id: r.id } : {}),
					name: r.name.trim(),
					url: r.url.trim(),
					...(r.removeToken ? { token: null } : r.token.trim() ? { token: r.token.trim() } : {}),
					enabled: r.enabled
				}))
		});
		saving = false;
		if (!updated) {
			saveError = true;
			return;
		}
		mcpRows = rowsFrom(updated.mcpServers);
		mcpSaved = mcpSnapshot(rowsFrom(updated.mcpServers));
		saveGen++;
		onSaved(updated);
		savedFlash = true;
		setTimeout(() => (savedFlash = false), 2000);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		// Escape unwinds one layer at a time: pending confirm, then the modal.
		if (confirmRevoke) confirmRevoke = null;
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
				{#each [{ id: 'general', icon: 'settings', label: m.settings_general() }, { id: 'memory', icon: 'sparkle', label: m.settings_memory() }, { id: 'connectors', icon: 'zap', label: m.settings_connectors() }, { id: 'apikeys', icon: 'key', label: m.apikeys_title() }] as item (item.id)}
					<button
						onclick={() => (section = item.id as Section)}
						class="flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm whitespace-nowrap transition
							{section === item.id
							? 'bg-white font-medium text-neutral-900 shadow-sm'
							: 'text-neutral-600 hover:bg-white/60'}"
					>
						<Icon name={item.icon as 'settings' | 'sparkle' | 'zap' | 'key'} size={16} />
						{item.label}
					</button>
				{/each}
				{#if settings.role === 'admin'}
					<!-- Administration lives in the organization console — this is a
					     door, not a section. -->
					<button
						onclick={() => {
							onClose();
							goto('/organization');
						}}
						class="flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm whitespace-nowrap text-neutral-600 transition hover:bg-white/60"
					>
						<Icon name="users" size={16} />
						<span class="min-w-0 flex-1 truncate">{m.admin_title()}</span>
						<Icon name="arrow-right" size={13} class="shrink-0 text-neutral-400" />
					</button>
				{/if}
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
					<h2 class="font-serif text-xl font-semibold text-neutral-900">{m.settings_mcp_title()}</h2>
					<p class="mt-1.5 text-sm leading-relaxed text-neutral-500">{m.settings_mcp_desc()}</p>

					<div class="mt-5 space-y-3">
						{#each mcpRows as row, i (row.id ?? i)}
							{@const tkey = row.id ?? `new-${i}`}
							<div class="rounded-xl border border-neutral-200 p-3.5">
								<div class="flex items-center gap-2">
									<input
										bind:value={row.name}
										maxlength="40"
										placeholder={m.settings_mcp_name_placeholder()}
										autocapitalize="none"
										spellcheck="false"
										class="w-32 min-w-0 rounded-lg border border-neutral-300 px-2.5 py-1.5 text-sm font-semibold transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
									/>
									<span class="ml-auto"></span>
									<button
										onclick={() => (row.enabled = !row.enabled)}
										role="switch"
										aria-checked={row.enabled}
										title={row.enabled ? m.settings_mcp_enabled() : m.settings_mcp_disabled()}
										class="relative h-5 w-9 shrink-0 rounded-full transition {row.enabled ? 'bg-[#d97757]' : 'bg-neutral-300'}"
									>
										<span class="absolute top-0.5 size-4 rounded-full bg-white transition-all {row.enabled ? 'left-4' : 'left-0.5'}"></span>
									</button>
									<button
										onclick={() => removeMcpRow(i)}
										class="grid size-8 shrink-0 place-items-center rounded-lg text-neutral-400 transition hover:bg-red-50 hover:text-red-600"
										title={m.settings_mcp_remove()}
										aria-label={m.settings_mcp_remove()}
									>
										<Icon name="trash" size={14} />
									</button>
								</div>
								<input
									bind:value={row.url}
									maxlength="300"
									placeholder="https://…/mcp"
									autocapitalize="none"
									spellcheck="false"
									class="mt-2 w-full rounded-lg border border-neutral-300 px-2.5 py-1.5 font-mono text-xs transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
								/>
								{#key saveGen}
									<TokenField tokenSet={row.tokenSet} bind:value={row.token} bind:removeFlag={row.removeToken} />
								{/key}
								<div class="mt-2 flex items-start gap-2">
									<button
										onclick={() => testConnector(tkey, { url: row.url.trim(), ...(row.id ? { id: row.id } : {}), ...(row.token.trim() ? { token: row.token.trim() } : {}) })}
										disabled={tests[tkey]?.busy || !row.url.trim()}
										class="shrink-0 rounded-lg border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-600 transition hover:border-[#d97757]/50 hover:text-[#bd5d3a] disabled:opacity-50"
									>
										{tests[tkey]?.busy ? m.settings_mcp_testing() : m.settings_mcp_test()}
									</button>
									{#if tests[tkey] && !tests[tkey].busy}
										<p class="min-w-0 text-xs leading-relaxed break-words {tests[tkey].ok ? 'text-emerald-700' : 'text-red-600'}">
											{tests[tkey].ok ? '✓ ' : '✗ '}{tests[tkey].detail}
										</p>
									{/if}
								</div>
							</div>
						{/each}
					</div>

					{#if mcpRows.length < 5}
						<button
							onclick={addMcpRow}
							class="mt-3 flex items-center gap-1.5 rounded-lg border border-dashed border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-500 transition hover:border-[#d97757]/50 hover:bg-[#d97757]/5 hover:text-[#bd5d3a]"
						>
							<Icon name="plus" size={13} />
							{m.settings_mcp_add()}
						</button>
					{/if}
					<p class="mt-2 text-[11px] text-neutral-400">{m.settings_mcp_hint()}</p>
				{:else if section === 'apikeys'}
					<h2 class="font-serif text-xl font-semibold text-neutral-900">{m.apikeys_title()}</h2>
					<p class="mt-1.5 max-w-xl text-sm leading-relaxed text-neutral-500">
						{m.apikeys_subtitle()}
					</p>

					<p class="mt-4 text-xs text-neutral-500">{m.apikeys_usage_hint()}</p>
					<pre
						class="mt-1.5 overflow-x-auto rounded-xl border border-[#e9e6dd] bg-[#faf9f5] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-neutral-600">{curlExample}</pre>
					<pre
						class="mt-1.5 overflow-x-auto rounded-xl border border-[#e9e6dd] bg-[#faf9f5] px-3 py-2.5 font-mono text-[11px] leading-relaxed text-neutral-600">{pythonExample}</pre>

					<!-- Mint form -->
					<div
						class="mt-5 flex flex-col gap-3 border-t border-[#efede3] pt-5 sm:flex-row sm:items-end sm:gap-2"
					>
						<div class="min-w-0 flex-1">
							<label for="set-keylabel" class="mb-1.5 block text-sm font-medium text-neutral-700">
								{m.apikeys_label()}
							</label>
							<input
								id="set-keylabel"
								type="text"
								bind:value={keyLabel}
								onkeydown={(e) => e.key === 'Enter' && submitNewKey()}
								maxlength="80"
								placeholder={m.apikeys_label_placeholder()}
								class="w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm transition placeholder:text-neutral-400 focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
							/>
						</div>
						<!-- Expiry and submit share one row on phones; sm:contents folds
						     them back into the parent row from sm up. -->
						<div class="flex items-end gap-2 sm:contents">
							<div class="min-w-0 flex-1 sm:flex-none">
								<span class="mb-1.5 block text-sm font-medium text-neutral-700">{m.apikeys_scope()}</span>
								<SelectMenu options={scopeOptions} bind:value={keyScope} menuClass="min-w-[15rem]" />
							</div>
							<div class="min-w-0 flex-1 sm:flex-none">
								<span class="mb-1.5 block text-sm font-medium text-neutral-700">{m.apikeys_expiry()}</span>
								<SelectMenu options={expiryOptions} bind:value={keyExpiry} />
							</div>
							<button
								onclick={submitNewKey}
								disabled={creatingKey}
								class="shrink-0 rounded-xl bg-[#d97757] px-3.5 py-2 text-sm font-medium text-white transition hover:bg-[#bd5d3a] disabled:opacity-40"
							>
								{creatingKey ? m.apikeys_creating() : m.apikeys_create()}
							</button>
						</div>
					</div>

					{#if keyError}
						<p class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{m.apikeys_error()}</p>
					{/if}

					<!-- One-time reveal — dismissing this drops the only plaintext copy. -->
					{#if freshKey}
						<div
							transition:fade={{ duration: 120 }}
							class="mt-4 rounded-xl border border-[#d97757]/40 bg-[#fdf3ef] p-4"
						>
							<div class="flex items-center gap-2">
								<Icon name="key" size={14} class="shrink-0 text-[#bd5d3a]" />
								<span class="text-sm font-semibold text-neutral-900">{m.apikeys_new_title()}</span>
							</div>
							<p class="mt-1 text-xs text-neutral-600">{m.apikeys_new_hint()}</p>
							<div class="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
								<code
									class="min-w-0 flex-1 truncate rounded-lg border border-[#e3d3cb] bg-white px-3 py-2 font-mono text-xs text-neutral-800"
								>
									{freshKey}
								</code>
								<button
									onclick={copyFreshKey}
									class="flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-[#d97757] px-3 py-2 text-xs font-medium text-white transition hover:bg-[#bd5d3a]"
								>
									<Icon name={freshCopied ? 'check' : 'copy'} size={13} />
									{freshCopied ? m.apikeys_copied() : m.copy()}
								</button>
							</div>
							<button
								onclick={() => (freshKey = null)}
								class="mt-2.5 rounded-lg px-2 py-1 text-xs font-medium text-neutral-500 transition hover:bg-white/70 hover:text-neutral-800"
							>
								{m.apikeys_done()}
							</button>
						</div>
					{/if}

					<!-- Existing keys -->
					<div class="mt-5">
						{#if keysLoaded && keys.length === 0}
							<p class="text-sm text-neutral-400">{m.apikeys_empty()}</p>
						{/if}
						{#each keys as k (k.id)}
							{@const expired = isExpired(k)}
							<div class="flex items-center gap-3 border-b border-[#efede3] py-3">
								<span
									class="grid size-8 shrink-0 place-items-center rounded-lg {expired
										? 'bg-neutral-100 text-neutral-400'
										: 'bg-[#d97757]/12 text-[#bd5d3a]'}"
								>
									<Icon name="key" size={14} />
								</span>
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2">
										<span class="truncate text-sm font-medium text-neutral-800">{k.label}</span>
										{#if k.hint}
											<span class="shrink-0 font-mono text-[11px] text-neutral-400">{k.hint}</span>
										{/if}
										<span class="shrink-0 rounded bg-[#f0eee6] px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
											{k.scope === 'chat' ? m.apikeys_scope_chat() : m.apikeys_scope_full()}
										</span>
										{#if expired}
											<span
												class="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-neutral-500 uppercase"
											>
												{m.apikeys_expired()}
											</span>
										{/if}
									</div>
									<div class="mt-0.5 text-xs text-neutral-500">
										{m.apikeys_created_at({ date: formatDate(k.createdAt) })} ·
										{k.lastUsedAt
											? m.apikeys_last_used({ date: formatDate(k.lastUsedAt) })
											: m.apikeys_never_used()}{k.expiresAt
											? ` · ${m.apikeys_expires_at({ date: formatDate(k.expiresAt) })}`
											: ''}
									</div>
								</div>
								{#if confirmRevoke === k.id}
									<button
										onclick={() => doRevoke(k.id)}
										title={m.apikeys_revoke_confirm()}
										class="shrink-0 rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-red-700"
									>
										{m.apikeys_revoke()}?
									</button>
								{:else}
									<button
										onclick={() => (confirmRevoke = k.id)}
										class="shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50"
									>
										{m.apikeys_revoke()}
									</button>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Footer (memory and keys apply immediately — no batch save) -->
			<div
				class="flex shrink-0 items-center justify-end gap-3 border-t border-[#efede3] px-4 py-3.5 sm:px-7
					{section === 'memory' || section === 'apikeys' ? 'invisible' : ''}"
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

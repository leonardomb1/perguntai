<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { flip } from 'svelte/animate';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import ChatPane from '$lib/components/ChatPane.svelte';
	import ArtifactPanel from '$lib/components/ArtifactPanel.svelte';
	import { closeArtifact } from '$lib/artifact-panel.svelte';
	import SchedulePane from '$lib/components/SchedulePane.svelte';
	import { fetchSchedules, type UserSchedule } from '$lib/schedules';
	import Avatar from '$lib/components/Avatar.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import ConversationDocs from '$lib/components/ConversationDocs.svelte';
	import SettingsModal from '$lib/components/SettingsModal.svelte';
	import OnboardingModal from '$lib/components/OnboardingModal.svelte';
	import { getDisplayName, getToken, clearSession, hasSession } from '$lib/session';
	import { fetchSettings, type PublicSettings } from '$lib/settings';
	import { newId } from '$lib/id';
	import type { UIMessage } from 'ai';
	import {
		listConversations,
		loadMessages,
		deleteConversation,
		renameConversation,
		migrateLocalConversations,
		type ConversationMeta
	} from '$lib/history';

	// Redirect straight to login when no session is stored.
	$effect(() => {
		if (browser && !hasSession()) goto('/login');
	});

	let conversations = $state<ConversationMeta[]>([]);
	let currentId = $state<string>(newId());
	let sidebarOpen = $state(false);
	// Messages are fetched from the server before the pane mounts. They are
	// stored TOGETHER with the id they belong to: rendering guards on
	// pane.id === currentId, so a stale message set can never mount against a
	// newer conversation id (that mismatch used to duplicate conversations).
	let pane = $state<{ id: string; messages: UIMessage[] } | null>(null);
	let paneRef = $state<{ markDeleted: () => void } | null>(null);

	const username = $derived(browser ? (getDisplayName() ?? 'user') : 'user');

	// Per-user settings drive the shown name and gate first-login onboarding.
	// `?settings=1` deep-links straight into the settings modal.
	let settings = $state<PublicSettings | null>(null);
	let settingsOpen = $state(browser && new URLSearchParams(location.search).has('settings'));
	const shownName = $derived(settings?.displayName || settings?.fullName || username);

	$effect(() => {
		if (!browser || !hasSession()) return;
		fetchSettings().then((s) => (settings = s));
	});

	// Scheduled-run transcripts are conversations too, but they belong under
	// their schedule in PROGRAMADO — keep them out of the chats list.
	const isRunConversation = (id: string) => id.startsWith('sched-');

	async function refreshList() {
		conversations = (await listConversations()).filter((c) => !isRunConversation(c.id));
	}

	// Autosave returns the saved conversation's index entry — move/insert it at
	// the top of the sidebar locally instead of re-fetching the whole list
	// (saves fire on every streaming pause, so the GETs added up fast).
	function upsertConversation(meta: ConversationMeta | null) {
		if (!meta) return;
		if (!isRunConversation(meta.id)) {
			conversations = [meta, ...conversations.filter((c) => c.id !== meta.id)];
		}
		// The agent can create/delete schedules mid-turn (scheduleReport tool) —
		// piggyback a throttled refresh on the autosave pulses so the sidebar
		// picks them up without polling.
		maybeRefreshSchedules();
	}

	let lastSchedulesFetch = 0;
	function maybeRefreshSchedules() {
		if (!schedulesEnabled) return;
		const now = Date.now();
		if (now - lastSchedulesFetch < 5000) return;
		lastSchedulesFetch = now;
		fetchSchedules().then((data) => {
			if (data) schedules = data.schedules;
		});
	}

	// One-time migration of pre-server localStorage history, then load the list.
	$effect(() => {
		if (!browser || !hasSession()) return;
		migrateLocalConversations().then(refreshList);
	});

	// Fetch the selected conversation's messages (a brand-new id resolves to []).
	$effect(() => {
		const id = currentId;
		if (!browser || !hasSession()) return;
		loadMessages(id).then((messages) => {
			if (id === currentId) pane = { id, messages };
		});
	});

	// --- Programado (scheduled runs) ---
	let schedules = $state<UserSchedule[]>([]);
	let schedulesEnabled = $state(false);
	/** null = chat view; '__new__' = create form; else a schedule id. */
	let selectedScheduleId = $state<string | null>(null);
	$effect(() => {
		if (!browser || !hasSession()) return;
		fetchSchedules().then((data) => {
			if (data) {
				schedulesEnabled = data.enabled;
				schedules = data.schedules;
			}
		});
	});
	const selectedSchedule = $derived(
		selectedScheduleId && selectedScheduleId !== '__new__'
			? (schedules.find((s) => s.id === selectedScheduleId) ?? null)
			: null
	);
	function openSchedule(id: string) {
		selectedScheduleId = id;
		sidebarOpen = false;
		closeArtifact();
	}
	function onScheduleChanged(updated: UserSchedule) {
		const idx = schedules.findIndex((s) => s.id === updated.id);
		if (idx >= 0) schedules[idx] = updated;
		else schedules = [...schedules, updated];
		selectedScheduleId = updated.id;
	}
	function onScheduleDeleted() {
		schedules = schedules.filter((s) => s.id !== selectedScheduleId);
		selectedScheduleId = null;
	}

	function newChat() {
		currentId = newId();
		sidebarOpen = false;
		selectedScheduleId = null;
		closeArtifact();
	}

	function openConversation(id: string) {
		if (id !== currentId || selectedScheduleId) closeArtifact();
		currentId = id;
		selectedScheduleId = null;
		sidebarOpen = false;
	}

	async function removeConversation(event: MouseEvent, id: string) {
		event.stopPropagation();
		// Deleting the OPEN conversation: silence its pane first, or its
		// teardown flush re-saves the messages and resurrects the conversation.
		if (id === currentId) paneRef?.markDeleted();
		await deleteConversation(id);
		await refreshList();
		if (id === currentId) newChat();
	}

	// Double-click a conversation title to rename it inline.
	let renamingId = $state<string | null>(null);
	let renameDraft = $state('');

	function startRename(convo: ConversationMeta) {
		renamingId = convo.id;
		renameDraft = convo.title;
	}

	async function commitRename() {
		const id = renamingId;
		renamingId = null;
		if (id) {
			await renameConversation(id, renameDraft);
			await refreshList();
		}
	}

	/**
	 * Signing out has a server side now: it drops the stored OIDC refresh token
	 * (the thing that can still mint warehouse credentials) and returns where to
	 * go next — the IdP's end-session endpoint, which bounces back to
	 * /login?signedout. Clearing localStorage alone would leave that token live.
	 */
	async function logout() {
		let redirectTo = '/login?signedout';
		try {
			const res = await fetch('/auth/logout', {
				method: 'POST',
				headers: { Authorization: `Bearer ${getToken() ?? ''}` }
			});
			if (res.ok) redirectTo = (await res.json()).redirectTo ?? redirectTo;
		} catch {
			// Offline or server down — still sign out locally.
		}
		clearSession();
		// Full navigation, not goto(): the destination is usually the IdP.
		location.href = redirectTo;
	}
</script>

<svelte:head>
	<title>PerguntAI</title>
</svelte:head>

<div class="flex h-full bg-[#faf9f5]">
	<!-- Sidebar -->
	<aside
		class="absolute inset-y-0 left-0 z-20 flex w-72 flex-col border-r border-[#e3e0d5] bg-[#f0eee6] transition-transform sm:static sm:translate-x-0
			{sidebarOpen ? 'translate-x-0' : '-translate-x-full'}"
	>
		<div class="flex items-center justify-between p-3 pb-1">
			<span class="px-1 text-lg font-semibold tracking-tight text-neutral-800">PerguntAI</span>
			<div class="flex items-center gap-1">
				<button
					onclick={newChat}
					class="rounded-lg p-2 text-neutral-600 transition hover:bg-white/70 hover:text-[#bd5d3a]"
					title={m.new_chat()}
					aria-label={m.new_chat()}
				>
					<Icon name="square-pen" size={18} />
				</button>
				<button
					onclick={() => (sidebarOpen = false)}
					class="rounded-lg p-2 text-neutral-500 hover:bg-white/70 sm:hidden"
					title={m.close_sidebar()}
					aria-label={m.close_sidebar()}
				>
					<Icon name="x" size={18} />
				</button>
			</div>
		</div>

		<nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
			{#if schedulesEnabled || schedules.length > 0}
				<div class="flex items-center justify-between px-2 py-1.5">
					<h2 class="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
						{m.sched_section()}
					</h2>
					{#if schedulesEnabled}
						<button
							onclick={() => openSchedule('__new__')}
							class="rounded p-0.5 text-neutral-400 transition hover:text-[#bd5d3a]"
							title={m.sched_new()}
							aria-label={m.sched_new()}
						>
							<Icon name="plus" size={14} />
						</button>
					{/if}
				</div>
				{#if schedules.length === 0}
					<p class="px-2 py-2 text-center text-xs text-neutral-400">{m.sched_none()}</p>
				{/if}
				{#each schedules as sched (sched.id)}
					<button
						onclick={() => openSchedule(sched.id)}
						class="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition
							{sched.id === selectedScheduleId
							? 'bg-white text-neutral-900 shadow-sm'
							: 'text-neutral-600 hover:bg-white/60'}"
					>
						<Icon
							name="clock"
							size={14}
							class="shrink-0 {sched.enabled ? 'text-[#bd5d3a]' : 'text-neutral-300'}"
						/>
						<span class="min-w-0 flex-1 truncate">{sched.title}</span>
					</button>
				{/each}
			{/if}

			<h2 class="px-2 py-1.5 text-xs font-semibold tracking-wide text-neutral-500 uppercase {schedulesEnabled || schedules.length > 0 ? 'mt-4' : ''}">
				{m.chats()}
			</h2>
			{#if conversations.length === 0}
				<p class="px-2 py-3 text-center text-xs text-neutral-400">{m.no_conversations()}</p>
			{/if}
			{#each conversations as convo (convo.id)}
				<div
					animate:flip={{ duration: 250 }}
					role="button"
					tabindex="0"
					onclick={() => openConversation(convo.id)}
					onkeydown={(e) => e.key === 'Enter' && openConversation(convo.id)}
					class="group flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition
						{convo.id === currentId && !selectedScheduleId
						? 'bg-white text-neutral-900 shadow-sm'
						: 'text-neutral-600 hover:bg-white/60'}"
				>
					{#if renamingId === convo.id}
						<!-- svelte-ignore a11y_autofocus -->
						<input
							bind:value={renameDraft}
							onblur={commitRename}
							onkeydown={(e) => {
								if (e.key === 'Enter') commitRename();
								if (e.key === 'Escape') renamingId = null;
							}}
							onclick={(e) => e.stopPropagation()}
							autofocus
							class="min-w-0 flex-1 rounded border border-[#d97757]/50 bg-white px-1.5 py-0.5 text-sm outline-none"
						/>
					{:else}
						<span
							role="presentation"
							class="min-w-0 flex-1 truncate"
							ondblclick={() => startRename(convo)}
							title={m.rename_hint({ title: convo.title })}
						>
							{convo.title}
						</span>
					{/if}
					<button
						onclick={(e) => removeConversation(e, convo.id)}
						class="invisible shrink-0 rounded p-1 text-neutral-400 group-hover:visible hover:bg-red-50 hover:text-red-600 focus-visible:visible"
						title={m.delete_conversation()}
						aria-label={m.delete_conversation()}
					>
						<Icon name="trash" size={14} />
					</button>
				</div>
			{/each}

		</nav>


		<div class="flex items-center gap-2.5 border-t border-[#e3e0d5] p-3">
			<Avatar {username} size={32} />
			<span class="min-w-0 flex-1 truncate text-sm text-neutral-700">{shownName}</span>
			<button
				onclick={() => (settingsOpen = true)}
				class="shrink-0 rounded-lg p-2 text-neutral-500 transition hover:bg-[#d97757]/10 hover:text-[#bd5d3a]"
				title={m.settings_title()}
				aria-label={m.settings_title()}
			>
				<Icon name="settings" size={16} />
			</button>
			<button
				onclick={logout}
				class="shrink-0 rounded-lg p-2 text-neutral-500 transition hover:bg-[#d97757]/10 hover:text-[#bd5d3a]"
				title={m.sign_out()}
				aria-label={m.sign_out()}
			>
				<Icon name="log-out" size={16} />
			</button>
		</div>
	</aside>

	{#if sidebarOpen}
		<button
			class="absolute inset-0 z-10 bg-black/20 sm:hidden"
			onclick={() => (sidebarOpen = false)}
			aria-label={m.close_sidebar()}
		></button>
	{/if}

	<!-- Chat area -->
	<div class="relative flex min-w-0 flex-1 flex-col">
		<div class="flex shrink-0 items-center justify-between px-4 pt-3 sm:justify-end">
			<button
				onclick={() => (sidebarOpen = true)}
				class="rounded-lg border border-[#e3e0d5] bg-white p-2 text-neutral-600 sm:hidden"
				title={m.open_sidebar()}
				aria-label={m.open_sidebar()}
			>
				<Icon name="menu" size={18} />
			</button>
			{#key currentId}
				<ConversationDocs conversationId={currentId} />
			{/key}
		</div>

		{#if selectedScheduleId}
			{#key selectedScheduleId}
				<SchedulePane
					schedule={selectedSchedule}
					onChanged={onScheduleChanged}
					onDeleted={onScheduleDeleted}
					onOpenConversation={openConversation}
				/>
			{/key}
		{:else}
		{#key currentId}
			{#if pane?.id === currentId}
				<ChatPane
					bind:this={paneRef}
					conversationId={pane.id}
					initialMessages={pane.messages}
					displayName={shownName}
					onSaved={upsertConversation}
				/>
			{:else}
				<div class="flex flex-1 items-center justify-center">
					<span
						class="size-6 animate-spin rounded-full border-[3px] border-[#e3e0d5] border-t-[#d97757]"
					></span>
				</div>
			{/if}
		{/key}
		{/if}
	</div>

	<ArtifactPanel />
</div>

{#if settingsOpen && settings}
	<SettingsModal
		{username}
		{settings}
		onClose={() => (settingsOpen = false)}
		onSaved={(updated) => (settings = updated)}
	/>
{/if}

{#if settings && !settings.onboarded}
	<OnboardingModal {username} onDone={(updated) => (settings = updated ?? { ...settings!, onboarded: true })} />
{/if}

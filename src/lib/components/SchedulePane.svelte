<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale } from '$lib/paraglide/runtime';
	import { Chat } from '@ai-sdk/svelte';
	import { DefaultChatTransport } from 'ai';
	import { getToken } from '$lib/session';
	import Icon from './Icon.svelte';
	import Markdown from './Markdown.svelte';
	import ChatMessage from './ChatMessage.svelte';
	import {
		fetchRuns,
		saveSchedule,
		deleteSchedule,
		type ScheduleRun,
		type UserSchedule
	} from '$lib/schedules';

	/**
	 * The Programado pane: one schedule's header (cadence, toggle, run-now),
	 * an edit form, and the run history — each run a quiet card with the
	 * agent's final report, Claude-style.
	 */
	let {
		schedule,
		onChanged,
		onDeleted
	}: {
		schedule: UserSchedule | null; // null = create mode
		onChanged: (updated: UserSchedule) => void;
		onDeleted: () => void;
	} = $props();

	// The pane is {#key}-ed by schedule id, so capturing the initial values on
	// mount is exactly what we want (same pattern as SettingsModal).
	// svelte-ignore state_referenced_locally
	let editing = $state(schedule === null);
	// svelte-ignore state_referenced_locally
	let draft = $state({
		title: schedule?.title ?? '',
		instructions: schedule?.instructions ?? '',
		frequency: (schedule?.frequency ?? 'daily') as 'daily' | 'weekly' | 'monthly',
		time: schedule?.time ?? '08:00',
		weekday: schedule?.weekday ?? 1,
		dayOfMonth: schedule?.dayOfMonth ?? 1
	});
	let busy = $state(false);
	let runs = $state<ScheduleRun[]>([]);
	let runsLoaded = $state(false);
	let openRun = $state<string | null>(null);

	$effect(() => {
		const id = schedule?.id;
		runs = [];
		runsLoaded = false;
		if (!id) return;
		fetchRuns(id).then((list) => {
			runs = list;
			runsLoaded = true;
			openRun = list[0]?.id ?? null;
		});
	});

	const locale = () => (getLocale() === 'en' ? 'en-US' : 'pt-BR');
	const weekdays = $derived(
		[0, 1, 2, 3, 4, 5, 6].map((d) => ({
			value: d,
			label: new Intl.DateTimeFormat(locale(), { weekday: 'long' }).format(new Date(2024, 0, 7 + d))
		}))
	);

	function cadenceLabel(s: UserSchedule): string {
		if (s.frequency === 'daily') return m.sched_cadence_daily({ time: s.time });
		if (s.frequency === 'weekly')
			return m.sched_cadence_weekly({
				day: weekdays[s.weekday ?? 1]?.label ?? '',
				time: s.time
			});
		return m.sched_cadence_monthly({ day: s.dayOfMonth ?? 1, time: s.time });
	}

	function fmtDate(iso: string): string {
		return new Date(iso).toLocaleString(locale(), {
			day: '2-digit',
			month: 'short',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	async function save() {
		if (busy || !draft.title.trim() || !draft.instructions.trim()) return;
		busy = true;
		const saved = await saveSchedule({
			...(schedule ? { id: schedule.id } : {}),
			title: draft.title.trim(),
			instructions: draft.instructions.trim(),
			frequency: draft.frequency,
			time: draft.time,
			...(draft.frequency === 'weekly' ? { weekday: draft.weekday } : {}),
			...(draft.frequency === 'monthly' ? { dayOfMonth: draft.dayOfMonth } : {})
		});
		busy = false;
		if (saved) {
			editing = false;
			onChanged(saved);
		}
	}

	async function toggleEnabled() {
		if (!schedule || busy) return;
		busy = true;
		const saved = await saveSchedule({
			id: schedule.id,
			title: schedule.title,
			instructions: schedule.instructions,
			frequency: schedule.frequency,
			time: schedule.time,
			weekday: schedule.weekday,
			dayOfMonth: schedule.dayOfMonth,
			enabled: !schedule.enabled
		});
		busy = false;
		if (saved) onChanged(saved);
	}

	async function remove() {
		if (!schedule || busy || !confirm(m.sched_delete_confirm())) return;
		busy = true;
		const ok = await deleteSchedule(schedule.id);
		busy = false;
		if (ok) onDeleted();
	}

	// "Executar agora" streams the run live: a throwaway Chat instance renders
	// the agent's reasoning and tool calls through the same components as a
	// normal conversation. The server persists the run regardless of this
	// socket, so navigating away only hides the live view — the result still
	// lands in the history.
	let runChat = $state<Chat | null>(null);
	const liveBusy = $derived(
		runChat !== null && (runChat.status === 'submitted' || runChat.status === 'streaming')
	);
	$effect(() => {
		// When the live run settles (an assistant message exists and streaming
		// stopped), fold it into the history list — only clearing the live view
		// once the refreshed history is actually on screen.
		if (runChat && !liveBusy && runChat.messages.some((msg) => msg.role === 'assistant')) {
			const id = schedule?.id;
			const settled = runChat;
			if (!id) {
				runChat = null;
				return;
			}
			setTimeout(() => {
				fetchRuns(id).then((list) => {
					runs = list;
					openRun = list[0]?.id ?? null;
					if (runChat === settled) runChat = null;
				});
			}, 300);
		}
	});

	function fireNow() {
		if (!schedule || liveBusy) return;
		const chat = new Chat({
			transport: new DefaultChatTransport({
				api: `/api/schedules/${encodeURIComponent(schedule.id)}/runs`,
				headers: () => ({ Authorization: `Bearer ${getToken() ?? ''}` })
			})
		});
		runChat = chat;
		// The text is a placeholder — the server composes the real prompt from
		// the schedule's standing instructions.
		chat.sendMessage({ text: m.sched_run_now() });
	}
</script>

<div class="flex h-full min-h-0 flex-col overflow-y-auto">
	<div class="mx-auto w-full max-w-3xl px-4 py-6">
		<!-- header -->
		<div class="flex flex-wrap items-center gap-2.5">
			<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-[#d97757]/10 text-[#bd5d3a]">
				<Icon name="clock" size={17} />
			</span>
			<div class="min-w-0 flex-1">
				<h2 class="truncate font-serif text-lg font-semibold text-neutral-900">
					{schedule?.title || m.sched_new()}
				</h2>
				{#if schedule}
					<p class="text-xs text-neutral-500">{cadenceLabel(schedule)}</p>
				{/if}
			</div>
			{#if schedule && !editing}
				<button
					onclick={fireNow}
					disabled={liveBusy}
					class="flex shrink-0 items-center gap-1.5 rounded-lg border border-[#e3e0d5] px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:border-[#d97757]/50 hover:text-[#bd5d3a] disabled:opacity-50"
				>
					{#if liveBusy}
						<span class="size-3 animate-spin rounded-full border-2 border-[#e3e0d5] border-t-[#d97757]"></span>
						{m.sched_running()}
					{:else}
						<Icon name="play" size={12} />
						{m.sched_run_now()}
					{/if}
				</button>
				<button
					onclick={() => (editing = true)}
					class="shrink-0 rounded-lg border border-[#e3e0d5] px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-[#faf9f5]"
				>
					{m.settings_memory_edit()}
				</button>
				<button
					onclick={remove}
					disabled={busy}
					class="shrink-0 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50"
				>
					{m.settings_memory_delete()}
				</button>
				<button
					role="switch"
					aria-checked={schedule.enabled}
					aria-label={m.sched_enabled()}
					disabled={busy}
					onclick={toggleEnabled}
					class="relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40
						{schedule.enabled ? 'bg-[#d97757]' : 'bg-[#d9d6c8]'}"
				>
					<span
						class="absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200
							{schedule.enabled ? 'translate-x-5' : 'translate-x-0'}"
					></span>
				</button>
			{/if}
		</div>

		{#if editing}
			<!-- edit / create form -->
			<div class="mt-5 space-y-3 rounded-xl border border-[#e3e0d5] bg-white p-4">
				<input
					bind:value={draft.title}
					maxlength="120"
					placeholder={m.sched_title_ph()}
					class="w-full rounded-lg border border-[#e3e0d5] bg-white px-3 py-2 text-sm font-medium transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
				/>
				<textarea
					bind:value={draft.instructions}
					maxlength="6000"
					rows="7"
					placeholder={m.sched_instructions_ph()}
					class="w-full resize-y rounded-lg border border-[#e3e0d5] bg-white px-3 py-2 text-sm leading-relaxed transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
				></textarea>
				<div class="flex flex-wrap items-center gap-2">
					<select
						bind:value={draft.frequency}
						class="rounded-lg border border-[#e3e0d5] bg-white px-2.5 py-2 text-sm focus:border-[#d97757] focus:outline-none"
					>
						<option value="daily">{m.sched_daily()}</option>
						<option value="weekly">{m.sched_weekly()}</option>
						<option value="monthly">{m.sched_monthly()}</option>
					</select>
					{#if draft.frequency === 'weekly'}
						<select
							bind:value={draft.weekday}
							class="rounded-lg border border-[#e3e0d5] bg-white px-2.5 py-2 text-sm capitalize focus:border-[#d97757] focus:outline-none"
						>
							{#each weekdays as day (day.value)}
								<option value={day.value}>{day.label}</option>
							{/each}
						</select>
					{:else if draft.frequency === 'monthly'}
						<input
							type="number"
							min="1"
							max="28"
							bind:value={draft.dayOfMonth}
							class="w-20 rounded-lg border border-[#e3e0d5] bg-white px-2.5 py-2 text-sm focus:border-[#d97757] focus:outline-none"
						/>
					{/if}
					<input
						type="time"
						bind:value={draft.time}
						class="rounded-lg border border-[#e3e0d5] bg-white px-2.5 py-2 text-sm focus:border-[#d97757] focus:outline-none"
					/>
					<span class="min-w-0 flex-1"></span>
					<button
						onclick={save}
						disabled={busy || !draft.title.trim() || !draft.instructions.trim()}
						class="rounded-lg bg-[#d97757] px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-[#bd5d3a] disabled:opacity-50"
					>
						{m.settings_save()}
					</button>
					{#if schedule}
						<button
							onclick={() => (editing = false)}
							class="rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-500 transition hover:text-neutral-800"
						>
							{m.cancel()}
						</button>
					{/if}
				</div>
			</div>
		{:else if schedule}
			<!-- standing instructions, folded -->
			<details class="mt-4 rounded-xl border border-[#e9e6dd] bg-[#faf9f5]">
				<summary class="cursor-pointer px-4 py-2.5 text-xs font-medium text-neutral-500 select-none">
					{m.sched_instructions()}
				</summary>
				<p class="px-4 pb-3 text-sm leading-relaxed whitespace-pre-wrap text-neutral-700">
					{schedule.instructions}
				</p>
			</details>

			{#if runChat}
				<!-- live run: the agent working, reasoning and tools included -->
				<div class="mt-5 rounded-xl border border-[#d97757]/30 bg-white p-4">
					<p class="mb-3 flex items-center gap-2 text-xs font-medium text-[#bd5d3a]">
						<span class="size-3 animate-spin rounded-full border-2 border-[#e3e0d5] border-t-[#d97757]"></span>
						{m.sched_running()}
					</p>
					<div class="flex flex-col gap-3">
						{#each runChat.messages.filter((msg) => msg.role === 'assistant') as message, i (message.id)}
							<ChatMessage
								{message}
								username="agenda"
								isLast={i === runChat.messages.filter((msg) => msg.role === 'assistant').length - 1}
								busy={liveBusy}
							/>
						{/each}
					</div>
					{#if runChat.status === 'error'}
						<p class="text-sm text-red-600">{runChat.error?.message?.slice(0, 300)}</p>
					{/if}
				</div>
			{/if}

			<!-- run history -->
			<h3 class="mt-6 mb-2 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
				{m.sched_history()}
			</h3>
			{#if !runsLoaded}
				<div class="grid place-items-center py-8">
					<span class="size-6 animate-spin rounded-full border-[3px] border-[#e3e0d5] border-t-[#d97757]"></span>
				</div>
			{:else if runs.length === 0}
				<p class="rounded-xl border border-dashed border-[#e3e0d5] px-4 py-6 text-center text-xs text-neutral-400">
					{m.sched_no_runs()}
				</p>
			{:else}
				<div class="space-y-2">
					{#each runs as run (run.id)}
						<div class="overflow-hidden rounded-xl border border-[#e3e0d5] bg-white">
							<button
								onclick={() => (openRun = openRun === run.id ? null : run.id)}
								class="flex w-full items-center gap-2.5 px-4 py-3 text-left"
							>
								<Icon
									name="clock"
									size={14}
									class="shrink-0 {run.status === 'ok' ? 'text-neutral-400' : 'text-red-400'}"
								/>
								<span class="min-w-0 flex-1 truncate text-sm text-neutral-700">
									{m.sched_run_executed()}
								</span>
								{#if run.status === 'error'}
									<span class="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-[11px] text-red-500">
										{m.tool_failed()}
									</span>
								{/if}
								<span class="shrink-0 text-xs text-neutral-400">{fmtDate(run.startedAt)}</span>
								<Icon
									name="chevron-down"
									size={13}
									class="shrink-0 text-neutral-300 transition-transform {openRun === run.id ? '' : '-rotate-90'}"
								/>
							</button>
							{#if openRun === run.id}
								<div class="border-t border-[#efede3] px-4 py-4">
									{#if run.tools.length}
										<p class="mb-3 text-xs text-neutral-400">
											{run.tools.join(', ')}
										</p>
									{/if}
									{#if run.status === 'error'}
										<p class="text-sm text-red-600">{run.error}</p>
									{:else}
										<div class="run-body"><Markdown content={run.text} /></div>
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	.run-body :global(.prose-chat) {
		font-size: 15px;
	}
</style>

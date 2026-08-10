<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { onDestroy } from 'svelte';
	import { Chat } from '@ai-sdk/svelte';
	import {
		DefaultChatTransport,
		getToolName,
		isDynamicToolUIPart,
		isToolUIPart,
		type UIMessage
	} from 'ai';
	import { goto } from '$app/navigation';
	import ChatMessage from './ChatMessage.svelte';
	import Icon from './Icon.svelte';
	import { getToken, getDisplayName, clearSession } from '$lib/session';
	import { saveFlowChat } from '$lib/flows';

	let {
		flowId,
		departmentId = null,
		initialMessages,
		model,
		readOnly = false,
		onFlowSaved
	}: {
		/** The flow being edited; null while composing a brand-new one. Reactive:
		 *  once a new flow is created the parent sets this, without remounting. */
		flowId: string | null;
		/** Department stamped on a newly-created flow (from the page's picker). */
		departmentId?: string | null;
		initialMessages: UIMessage[];
		model: string;
		/** View-only (a department flow the user can't edit): composer disabled. */
		readOnly?: boolean;
		onFlowSaved: (flowId: string, version: number) => void;
	} = $props();

	const loginName = getDisplayName() ?? 'user';

	// svelte-ignore state_referenced_locally
	const chat = new Chat({
		messages: initialMessages,
		transport: new DefaultChatTransport({
			api: '/api/flows/chat',
			headers: () => ({ Authorization: `Bearer ${getToken() ?? ''}` }),
			// Function form so the CURRENT flowId/department/model are read at send time.
			body: () => ({ flowId, departmentId, model })
		}),
		onError: (error) => {
			if (error.message.includes('401') || error.message.toLowerCase().includes('unauthorized')) {
				clearSession();
				goto('/login');
			}
		}
	});

	let input = $state('');
	let textarea = $state<HTMLTextAreaElement | null>(null);
	let scrollEl = $state<HTMLElement | null>(null);
	let contentEl = $state<HTMLElement | null>(null);
	let pinned = true;

	const busy = $derived(chat.status === 'submitted' || chat.status === 'streaming');

	// Notify the parent (to refresh the diagram) each time upsertFlow succeeds —
	// once per tool call. A new flow's id surfaces here for the first time.
	const seen = new Set<string>();
	let saveTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		void chat.messages.length;
		const last = chat.messages.at(-1);
		void last?.parts.length;
		void last?.parts.reduce((n, p) => n + ('text' in p && typeof p.text === 'string' ? p.text.length : 1), 0);

		for (const msg of chat.messages) {
			for (const part of msg.parts) {
				if (
					(isToolUIPart(part) || isDynamicToolUIPart(part)) &&
					getToolName(part) === 'upsertFlow' &&
					part.state === 'output-available'
				) {
					const out = part.output as { ok?: boolean; flowId?: string; version?: number } | undefined;
					if (out?.ok && out.flowId && !seen.has(part.toolCallId)) {
						seen.add(part.toolCallId);
						onFlowSaved(out.flowId, out.version ?? 0);
					}
				}
			}
		}

		if (flowId && chat.messages.length) {
			if (saveTimer) clearTimeout(saveTimer);
			const id = flowId;
			saveTimer = setTimeout(() => saveFlowChat(id, chat.messages), 500);
		}
	});

	$effect(() => {
		const el = scrollEl;
		const content = contentEl;
		if (!el || !content) return;
		el.scrollTop = el.scrollHeight;
		const ro = new ResizeObserver(() => {
			if (pinned) el.scrollTop = el.scrollHeight;
		});
		ro.observe(content);
		return () => ro.disconnect();
	});

	function handleScroll() {
		const el = scrollEl;
		if (!el) return;
		pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
	}

	onDestroy(() => {
		if (saveTimer) clearTimeout(saveTimer);
		chat.stop();
		if (flowId && chat.messages.length) saveFlowChat(flowId, chat.messages);
	});

	function send() {
		const text = input.trim();
		if (!text || busy || readOnly) return;
		input = '';
		if (textarea) textarea.style.height = 'auto';
		chat.sendMessage({ text });
	}

	function editMessage(messageId: string, text: string) {
		if (busy) return;
		const index = chat.messages.findIndex((msg) => msg.id === messageId);
		if (index === -1) return;
		chat.messages = chat.messages.slice(0, index);
		chat.sendMessage({ text });
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			send();
		}
	}
	function autogrow() {
		if (!textarea) return;
		textarea.style.height = 'auto';
		textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
	}
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<main
		bind:this={scrollEl}
		onscroll={handleScroll}
		class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
	>
		<div bind:this={contentEl} class="flex flex-col gap-6 px-4 py-6">
			{#if chat.messages.length === 0}
				<div class="mt-10 px-2 text-center">
					<span class="mx-auto mb-3 grid size-11 place-items-center rounded-xl bg-[#d97757]/12 text-[#bd5d3a]">
						<Icon name="zap" size={20} />
					</span>
					<p class="text-base font-semibold text-neutral-800">{m.flow_builder_greeting()}</p>
					<p class="mx-auto mt-1.5 max-w-xs text-xs text-neutral-500">{m.flow_builder_greeting_sub()}</p>
				</div>
			{/if}

			{#each chat.messages as message (message.id)}
				<svelte:boundary onerror={(e) => console.error('message render failed:', e)}>
					<ChatMessage
						{message}
						username={loginName}
						{busy}
						isLast={message.id === chat.messages.at(-1)?.id}
						onEdit={editMessage}
						onRegenerate={() => !busy && chat.regenerate()}
						onAsk={() => {}}
					/>
					{#snippet failed(_error, reset)}
						<div class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
							<button onclick={reset} class="underline">{m.try_again()}</button>
						</div>
					{/snippet}
				</svelte:boundary>
			{/each}

			{#if chat.status === 'submitted'}
				<div class="flex items-center gap-2 text-sm text-neutral-400">
					<span class="size-2 animate-bounce rounded-full bg-[#d97757]"></span>
					{m.thinking()}
				</div>
			{/if}

			{#if chat.error}
				<div class="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
					<span class="min-w-0">{chat.error.message}</span>
					<button onclick={() => chat.regenerate()} class="shrink-0 rounded border border-red-300 px-2 py-0.5 font-medium hover:bg-red-100">
						{m.retry()}
					</button>
				</div>
			{/if}
		</div>
	</main>

	<footer class="shrink-0 px-4 pt-1 pb-4">
		{#if readOnly}
			<div class="flex items-center justify-center gap-2 rounded-2xl border border-[#e3e0d5] bg-[#f7f6f1] px-4 py-3 text-xs text-neutral-500">
				<Icon name="key" size={13} />
				{m.flow_builder_readonly()}
			</div>
		{:else}
		<div class="rounded-2xl border border-[#e3e0d5] bg-white p-2 shadow-sm focus-within:border-[#d97757]/50 focus-within:ring-2 focus-within:ring-[#d97757]/15">
			<div class="flex items-end gap-1.5">
				<textarea
					bind:this={textarea}
					bind:value={input}
					oninput={autogrow}
					onkeydown={handleKeydown}
					placeholder={m.flow_builder_placeholder()}
					rows="1"
					class="max-h-[160px] min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] text-neutral-800 outline-none placeholder:text-neutral-400"
				></textarea>
				{#if busy}
					<button
						type="button"
						onclick={() => chat.stop()}
						class="grid size-9 shrink-0 place-items-center rounded-full border border-neutral-300 text-neutral-600 transition hover:bg-neutral-100"
						title={m.stop_generating()}
						aria-label={m.stop_generating()}
					>
						<Icon name="stop" size={14} />
					</button>
				{:else}
					<button
						type="button"
						onclick={send}
						disabled={!input.trim()}
						class="grid size-9 shrink-0 place-items-center rounded-full bg-[#d97757] text-white transition hover:bg-[#bd5d3a] disabled:opacity-40"
						title={m.send_message()}
						aria-label={m.send_message()}
					>
						<Icon name="arrow-up" size={17} />
					</button>
				{/if}
			</div>
		</div>
		{/if}
	</footer>
</div>

<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { tick } from 'svelte';
	import { Chat } from '@ai-sdk/svelte';
	import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
	import ChatMessage from '$lib/components/ChatMessage.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import logo from '$lib/assets/favicon.svg';

	/**
	 * The embedded surface: one anonymous, read-only conversation with the
	 * warehouse, meant to live inside an iframe. Stateless by design — history
	 * exists only in this component; "reset" recreates the Chat instance.
	 */
	let { data }: { data: { enabled: boolean; maxMessages: number; key: string | null } } = $props();

	let generation = $state(0); // bump to reset the conversation
	let input = $state('');
	let composerEl = $state<HTMLTextAreaElement | null>(null);
	let scrollEl = $state<HTMLElement | null>(null);

	const makeChat = () =>
		new Chat({
			transport: new DefaultChatTransport({
				api: '/api/embed/chat',
				// Per-portal embed key (emb_…) from ?key= — server-resolved to its
				// own service account and limits; absent = the env service account.
				body: () => (data.key ? { embedKey: data.key } : {})
			}),
			sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls
		});
	let chat = $state(makeChat());

	function reset() {
		chat = makeChat();
		generation += 1;
		input = '';
	}

	const busy = $derived(chat.status === 'submitted' || chat.status === 'streaming');
	const userTurns = $derived(chat.messages.filter((msg) => msg.role === 'user').length);
	const limitReached = $derived(userTurns >= data.maxMessages);
	const remaining = $derived(Math.max(0, data.maxMessages - userTurns));

	async function send() {
		const text = input.trim();
		if (!text || busy || limitReached) return;
		input = '';
		chat.sendMessage({ text });
		await tick();
		scrollEl?.scrollTo({ top: scrollEl.scrollHeight });
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			send();
		}
	}

	// Follow the stream.
	$effect(() => {
		void chat.messages.length;
		void chat.status;
		if (scrollEl) scrollEl.scrollTo({ top: scrollEl.scrollHeight });
	});

	function onAsk(toolCallId: string, label: string) {
		chat.addToolResult({ tool: 'askUser', toolCallId, output: { selected: label } });
	}
</script>

<svelte:head>
	<title>PerguntAI</title>
</svelte:head>

<div class="flex h-dvh flex-col bg-[#faf9f5] text-neutral-800">
	<header class="flex h-12 shrink-0 items-center gap-2.5 border-b border-[#e3e0d5] bg-white/80 px-4">
		<img src={logo} alt="" class="size-6" />
		<span class="text-sm font-semibold text-neutral-900">PerguntAI</span>
		<span class="min-w-0 flex-1"></span>
		{#if chat.messages.length > 0}
			<button
				onclick={reset}
				class="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-neutral-500 transition hover:bg-[#f0eee6] hover:text-neutral-800"
			>
				<Icon name="refresh" size={13} />
				{m.embed_reset()}
			</button>
		{/if}
	</header>

	{#if !data.enabled}
		<div class="grid flex-1 place-items-center px-6">
			<p class="text-sm text-neutral-500">{m.embed_disabled()}</p>
		</div>
	{:else}
		<main bind:this={scrollEl} class="min-h-0 flex-1 overflow-y-auto">
			<div class="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
				{#if chat.messages.length === 0}
					<div class="flex flex-col items-center gap-2 pt-[18vh] text-center">
						<img src={logo} alt="" class="size-10 opacity-90" />
						<p class="font-serif text-lg font-semibold text-neutral-800">{m.embed_welcome()}</p>
						<p class="max-w-sm text-sm text-neutral-500">{m.embed_welcome_sub()}</p>
					</div>
				{/if}
				{#key generation}
					{#each chat.messages as message, i (message.id)}
						<ChatMessage
							{message}
							username="visitante"
							isLast={i === chat.messages.length - 1}
							{busy}
							{onAsk}
						/>
					{/each}
				{/key}
				{#if chat.status === 'submitted'}
					<span
						class="size-4 shrink-0 animate-spin rounded-full border-2 border-[#e3e0d5] border-t-[#d97757]"
					></span>
				{/if}
				{#if chat.status === 'error'}
					<p class="text-sm text-red-600">
						{chat.error?.message?.slice(0, 300) ?? 'Erro — tente novamente.'}
					</p>
				{/if}
			</div>
		</main>

		<footer class="shrink-0 px-4 pt-1 pb-4">
			<div class="mx-auto max-w-3xl">
				{#if limitReached}
					<div
						class="flex flex-wrap items-center justify-center gap-3 rounded-2xl border border-[#e3e0d5] bg-white px-4 py-3"
					>
						<p class="text-sm text-neutral-600">{m.embed_limit_notice()}</p>
						<button
							onclick={reset}
							class="rounded-lg bg-[#d97757] px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-[#bd5d3a]"
						>
							{m.embed_reset()}
						</button>
					</div>
				{:else}
					<div
						class="flex items-end gap-2 rounded-2xl border border-[#e3e0d5] bg-white px-3 py-2 focus-within:border-[#d97757]/50"
					>
						<textarea
							bind:this={composerEl}
							bind:value={input}
							onkeydown={onKeydown}
							rows="1"
							placeholder={m.composer_placeholder()}
							class="max-h-40 min-h-[38px] w-full resize-none bg-transparent px-1 py-2 text-[15px] leading-snug outline-none placeholder:text-neutral-400"
						></textarea>
						<button
							onclick={send}
							disabled={busy || !input.trim()}
							aria-label="Enviar"
							class="grid size-9 shrink-0 place-items-center rounded-full bg-[#e8b4a0] text-white transition enabled:bg-[#d97757] enabled:hover:bg-[#bd5d3a] disabled:opacity-60"
						>
							<Icon name="arrow-up" size={16} />
						</button>
					</div>
					{#if userTurns > 0 && remaining <= 3}
						<p class="mt-1.5 text-center text-[11px] text-neutral-400">
							{remaining} / {data.maxMessages}
						</p>
					{/if}
				{/if}
			</div>
		</footer>
	{/if}
</div>

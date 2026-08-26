<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { onDestroy, onMount, tick } from 'svelte';
	import { Chat } from '@ai-sdk/svelte';
	import {
		DefaultChatTransport,
		getToolName,
		isDynamicToolUIPart,
		isToolUIPart,
		lastAssistantMessageIsCompleteWithToolCalls,
		type UIMessage
	} from 'ai';
	import { goto } from '$app/navigation';
	import ChatMessage from './ChatMessage.svelte';
	import ModelPicker from './ModelPicker.svelte';
	import Icon from './Icon.svelte';
	import { MODEL_STORAGE_KEY, type Provider } from '$lib/models';
	import { getToken, getDisplayName, clearSession } from '$lib/session';
	import { saveConversation, type ConversationMeta } from '$lib/history';
	import { imageToDataUrl } from '$lib/image';
	import { newId } from '$lib/id';
	import logo from '$lib/assets/favicon.svg';

	let {
		conversationId,
		initialMessages,
		displayName,
		onSaved
	}: {
		conversationId: string;
		initialMessages: UIMessage[];
		/** Preferred name from the user's settings — falls back to the login name. */
		displayName?: string;
		/** Receives the saved index entry (null on no-op) to update the sidebar in place. */
		onSaved: (meta: ConversationMeta | null) => void;
	} = $props();

	// Login username seeds the identicon (must match the sidebar avatar);
	// the settings display name is only for addressing the user in text.
	const loginName = getDisplayName() ?? 'user';
	const username = $derived(displayName || loginName);

	// The keyboard hint in the composer placeholder only makes sense with a
	// physical keyboard — on touch devices it wraps into a clipped second line.
	// Resolved in onMount (matchMedia is client-only).
	let hasKeyboard = $state(false);

	// A different welcome each time — picked once per pane mount (client-only,
	// so no SSR hydration mismatch).
	const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
	const greeting = pick([m.greeting_1, m.greeting_2, m.greeting_3, m.greeting_4, m.greeting_5]);
	const greetingSub = pick([m.greeting_sub_1, m.greeting_sub_2, m.greeting_sub_3]);

	// Model is chosen per conversation from the user's allow-list. Kept stable
	// for the pane's lifetime (never switched mid-conversation) so the big
	// tool+schema prompt cache — which is model-scoped — survives across turns.
	// The last pick is remembered so new chats default to it.
	// The catalog is deployment-defined (env), so the default arrives with the
	// fetch; until then an empty pick is fine — the server resolves '' (or any
	// unknown id) to its default model.
	const MODEL_KEY = MODEL_STORAGE_KEY;
	let models = $state<{ id: string; label: string; hint: string; provider: Provider }[]>([]);
	let selectedModel = $state(
		(typeof localStorage !== 'undefined' && localStorage.getItem(MODEL_KEY)) || ''
	);

	// Reattach + network-recovery listener (sync onMount so it can return its
	// cleanup): a run may still be streaming server-side from before a reload
	// or drop — resume if so (204 no-op otherwise), and retry whenever the
	// device comes back online after a network switch.
	onMount(() => {
		if (initialMessages.length > 0) void resume();
		const onOnline = () => {
			resumeAttempts = 0;
			scheduleResume();
		};
		// Coming back from another app / a backgrounded tab: mobile browsers kill
		// the fetch while hidden (and may have burned the retry attempts there),
		// so reattach as soon as the pane is visible again. An in-flight stream is
		// only presumed dead on TOUCH devices after a real absence — desktop tab
		// switches don't kill fetches, and reattaching one would blip a healthy
		// stream for nothing.
		let hiddenAt = 0;
		const onVisible = () => {
			if (document.visibilityState !== 'visible') {
				hiddenAt = Date.now();
				return;
			}
			const wasAway = hiddenAt > 0 && Date.now() - hiddenAt > 3000;
			const presumedDead =
				chat.status === 'error' ||
				((chat.status === 'streaming' || chat.status === 'submitted') && wasAway && !hasKeyboard);
			if (presumedDead) {
				resumeAttempts = 0;
				scheduleResume();
			}
		};
		window.addEventListener('online', onOnline);
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			window.removeEventListener('online', onOnline);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

	onMount(async () => {
		hasKeyboard = window.matchMedia('(pointer: fine)').matches;
		try {
			const res = await fetch('/api/models', {
				headers: { Authorization: `Bearer ${getToken() ?? ''}` }
			});
			if (!res.ok) return;
			const data = await res.json();
			models = data.models ?? [];
			// Drop a stale/revoked (or empty) pick back to a valid one.
			if (!models.some((mo) => mo.id === selectedModel)) selectedModel = data.default ?? '';
		} catch {
			// Non-fatal — the server falls back to the default model anyway.
		}
	});

	function pickModel(id: string) {
		selectedModel = id;
		try {
			localStorage.setItem(MODEL_KEY, id);
		} catch {
			/* private mode — sticky choice is best-effort */
		}
	}

	// The pane is {#key}-ed by conversation id, so capturing the initial
	// messages once at construction is exactly what we want.
	// svelte-ignore state_referenced_locally
	const chat = new Chat({
		// The chat id IS the conversation id: the SDK's resumeStream() reconnects
		// to GET /api/chat/{id}/stream, which is keyed by conversation server-side.
		id: conversationId,
		messages: initialMessages,
		transport: new DefaultChatTransport({
			api: '/api/chat',
			// JWT bearer auth — resolved per request so a re-login is picked up.
			headers: () => ({ Authorization: `Bearer ${getToken() ?? ''}` }),
			// Function form so the CURRENT model is read at send time. Scopes the
			// agent's document tools to this conversation; the server re-validates
			// the model against the user's allow-list.
			body: () => ({ conversationId, model: selectedModel })
		}),
		// When the model calls the client-side `askUser` tool (no server execute),
		// the turn pauses; once the user clicks an option and we add the result,
		// this re-sends so the agent continues. Only fires when the last step's
		// client tools are all resolved, so normal text answers don't loop.
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
		onError: (error) => {
			// Expired/invalid token → back to login.
			if (error.message.includes('401') || error.message.toLowerCase().includes('unauthorized')) {
				clearSession();
				goto('/login');
				return;
			}
			// Dropped connection (mobile network switch, backgrounded tab): the run
			// keeps going server-side, so quietly reattach to its buffered stream.
			scheduleResume(error);
		}
	});

	// --- stream resume (mobile drop resilience) ---
	// The server keeps a run alive and buffered independently of our socket;
	// resumeStream() replays it. Retries are capped so a genuinely down server
	// still surfaces its error instead of looping.
	//
	// The replay is the WHOLE run from its `start`, and the SDK appends replayed
	// parts onto whatever assistant message is already last — so our own copy of
	// that turn (persisted continuously, complete or partial) has to go first,
	// or the answer shows up twice. HEAD tells us whether there is anything to
	// replay before we drop it; if the replay then fails, the copy comes back.
	async function resume() {
		let available = false;
		try {
			const probe = await fetch(`/api/chat/${encodeURIComponent(conversationId)}/stream`, {
				method: 'HEAD',
				headers: { Authorization: `Bearer ${getToken() ?? ''}` }
			});
			available = probe.status === 200;
		} catch {
			return;
		}
		if (!available) return;

		const backup = chat.messages;
		if (backup.at(-1)?.role === 'assistant') chat.messages = backup.slice(0, -1);
		await chat.resumeStream().catch(() => {});
		if (chat.status === 'error' && chat.messages.at(-1)?.role !== 'assistant') {
			chat.messages = backup;
		}
	}

	let resumeAttempts = 0;
	let resumeTimer: ReturnType<typeof setTimeout> | null = null;
	function scheduleResume(error?: Error) {
		const message = (error?.message ?? '').toLowerCase();
		const networkish =
			!error || message.includes('network') || message.includes('fetch') || message.includes('load failed');
		if (!networkish || resumeAttempts >= 3) return;
		resumeAttempts += 1;
		if (resumeTimer) clearTimeout(resumeTimer);
		resumeTimer = setTimeout(() => {
			void resume().then(() => {
				if (chat.status === 'streaming' || chat.status === 'ready') resumeAttempts = 0;
			});
		}, 1500 * resumeAttempts);
	}

	// Explicit stop must now reach the SERVER — a closed socket no longer
	// cancels the run (that's the whole point of resumability).
	function stopRun() {
		void chat.stop();
		void fetch(`/api/chat/${encodeURIComponent(conversationId)}/stream`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${getToken() ?? ''}` }
		}).catch(() => {});
	}

	let input = $state('');
	let scrollContainer = $state<HTMLElement | null>(null);
	let textarea = $state<HTMLTextAreaElement | null>(null);
	// The composer card — the model menu anchors to it so it opens clear of the
	// card instead of floating over it.
	let composerEl = $state<HTMLElement | null>(null);

	// --- composer attachment (uploads into the RAG document store) ---
	let fileInput = $state<HTMLInputElement | null>(null);
	let uploading = $state(false);
	let uploadNote = $state<{ name: string; error?: string } | null>(null);

	async function uploadFromInput(event: Event) {
		const files = (event.target as HTMLInputElement).files;
		if (files) for (const file of files) await handleIncomingFile(file);
		if (fileInput) fileInput.value = '';
	}

	async function uploadFile(file: File) {
		uploading = true;
		uploadNote = null;
		try {
			const body = new FormData();
			body.append('file', file);
			body.append('conversationId', conversationId);
			const res = await fetch('/api/documents', {
				method: 'POST',
				headers: { Authorization: `Bearer ${getToken() ?? ''}` },
				body
			});
			const data = await res.json().catch(() => ({}));
			if (res.ok) {
				uploadNote = { name: file.name };
				// Let the sidebar document list refresh itself.
				window.dispatchEvent(new CustomEvent('perguntai:docs-changed'));
				setTimeout(() => (uploadNote = null), 4000);
			} else {
				uploadNote = {
					name: file.name,
					error:
						res.status === 413
							? m.upload_too_large()
							: res.status === 415
								? m.upload_unsupported()
								: (data.error ?? m.upload_failed())
				};
			}
		} catch {
			uploadNote = { name: file.name, error: m.upload_failed() };
		} finally {
			uploading = false;
		}
	}

	// --- pasted/dropped images & PDFs become per-message attachments ---
	// (the model sees them natively: images via vision, PDFs as documents)
	interface PendingAttachment {
		id: string;
		kind: 'image' | 'pdf';
		dataUrl: string;
		name: string;
	}
	let pendingAttachments = $state<PendingAttachment[]>([]);

	const MAX_PDF_BYTES = 6 * 1024 * 1024; // base64 inflation must fit BODY_SIZE_LIMIT

	async function attachFile(file: File) {
		try {
			if (file.type.startsWith('image/')) {
				const dataUrl = await imageToDataUrl(file);
				pendingAttachments = [
					...pendingAttachments,
					{ id: newId(), kind: 'image', dataUrl, name: file.name || 'imagem.png' }
				];
			} else {
				if (file.size > MAX_PDF_BYTES) {
					uploadNote = { name: file.name, error: m.upload_too_large() };
					return;
				}
				const dataUrl = await new Promise<string>((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () => resolve(reader.result as string);
					reader.onerror = reject;
					reader.readAsDataURL(file);
				});
				pendingAttachments = [
					...pendingAttachments,
					{ id: newId(), kind: 'pdf', dataUrl, name: file.name || 'documento.pdf' }
				];
			}
		} catch {
			uploadNote = { name: file.name || 'arquivo', error: m.image_attach_failed() };
		}
	}

	const isAttachable = (type: string) => type.startsWith('image/') || type === 'application/pdf';

	function onPaste(event: ClipboardEvent) {
		const files = [...(event.clipboardData?.items ?? [])]
			.filter((i) => i.kind === 'file' && isAttachable(i.type))
			.map((i) => i.getAsFile())
			.filter((f): f is File => f !== null);
		if (files.length === 0) return;
		event.preventDefault();
		for (const file of files) attachFile(file);
	}

	/** Images/PDFs attach to the message; everything else goes to the document store. */
	async function handleIncomingFile(file: File) {
		if (isAttachable(file.type)) await attachFile(file);
		else await uploadFile(file);
	}

	// --- drag & drop anywhere over the chat ---
	let dragging = $state(false);
	let dragDepth = 0;

	const hasFiles = (e: DragEvent) => e.dataTransfer?.types?.includes('Files') ?? false;

	function onDragEnter(e: DragEvent) {
		if (!hasFiles(e)) return;
		dragDepth++;
		dragging = true;
	}
	function onDragLeave(e: DragEvent) {
		if (!hasFiles(e)) return;
		dragDepth = Math.max(0, dragDepth - 1);
		if (dragDepth === 0) dragging = false;
	}
	function onDragOver(e: DragEvent) {
		if (hasFiles(e)) e.preventDefault(); // required, or the browser opens the file
	}
	async function onDrop(e: DragEvent) {
		if (!hasFiles(e)) return;
		e.preventDefault();
		dragDepth = 0;
		dragging = false;
		for (const file of e.dataTransfer?.files ?? []) await handleIncomingFile(file);
	}

	const busy = $derived(chat.status === 'submitted' || chat.status === 'streaming');

	// While the agent waits on an askUser choice, the composer locks so the
	// buttons are the one obvious way to answer — free typing comes back only
	// through the card's "chat instead" escape hatch (or by answering).
	const pendingAsk = $derived.by(() => {
		const last = chat.messages.at(-1);
		if (!last || last.role !== 'assistant') return null;
		for (const part of last.parts) {
			if (
				(isToolUIPart(part) || isDynamicToolUIPart(part)) &&
				getToolName(part) === 'askUser' &&
				part.state !== 'output-available' &&
				part.state !== 'output-error'
			)
				return part.toolCallId;
		}
		return null;
	});
	// Keyed by toolCallId so a NEW ask re-locks even after a previous unlock.
	let unlockedFor = $state<string | null>(null);
	const inputLocked = $derived(pendingAsk !== null && unlockedFor !== pendingAsk);

	function chatInstead() {
		unlockedFor = pendingAsk;
		tick().then(() => textarea?.focus());
	}

	// A free-text answer must still resolve the pending askUser call — a
	// dangling tool_use in the re-sent history is rejected by the provider.
	// Resolved by direct message mutation (same pattern as editMessage) rather
	// than addToolResult, whose sendAutomaticallyWhen auto-submit would race
	// the user's own send and fire a duplicate request.
	function resolvePendingAsks() {
		const last = chat.messages.at(-1);
		if (!last || last.role !== 'assistant') return;
		let changed = false;
		const parts = last.parts.map((part) => {
			if (
				(isToolUIPart(part) || isDynamicToolUIPart(part)) &&
				getToolName(part) === 'askUser' &&
				part.state !== 'output-available' &&
				part.state !== 'output-error'
			) {
				changed = true;
				return {
					...part,
					state: 'output-available',
					output: {
						selected: null,
						note: 'The user chose to answer in free text — see their next message.'
					}
				} as unknown as typeof part;
			}
			return part;
		});
		if (changed) chat.messages = [...chat.messages.slice(0, -1), { ...last, parts }];
	}

	// Persist continuously (debounced) so nothing is lost if the user switches
	// to another conversation mid-stream.
	let saveTimer: ReturnType<typeof setTimeout> | null = null;

	// Deleting the OPEN conversation used to resurrect it: the delete removed
	// the server file, then switching to a new chat destroyed this pane and the
	// teardown flush re-saved chat.messages. The page marks the pane deleted
	// before deleting, and every save path stands down.
	let deleted = false;
	export function markDeleted() {
		deleted = true;
		if (saveTimer) clearTimeout(saveTimer);
	}

	$effect(() => {
		// Subscribe to streaming progress: message count, part count, and the
		// growing text of the last message.
		void chat.messages.length;
		const last = chat.messages.at(-1);
		void last?.parts.length;
		void last?.parts.reduce(
			(n, p) => n + ('text' in p && typeof p.text === 'string' ? p.text.length : 1),
			0
		);
		if (chat.messages.length === 0 || deleted) return;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			if (deleted) return;
			// Refresh the sidebar only after the server confirms the save.
			saveConversation(conversationId, chat.messages).then(onSaved);
		}, 400);
	});

	// Switching conversations tears the pane down: abort the in-flight stream
	// and flush whatever arrived so the partial answer is kept.
	onDestroy(() => {
		if (saveTimer) clearTimeout(saveTimer);
		chat.stop();
		if (chat.messages.length > 0 && !deleted) {
			saveConversation(conversationId, chat.messages).then(onSaved);
		}
	});

	function send() {
		const text = input.trim();
		if ((!text && pendingAttachments.length === 0) || busy || inputLocked) return;
		const files = pendingAttachments.map((p) => ({
			type: 'file' as const,
			mediaType: p.dataUrl.slice(5, p.dataUrl.indexOf(';')),
			filename: p.name,
			url: p.dataUrl
		}));
		input = '';
		pendingAttachments = [];
		if (textarea) textarea.style.height = 'auto';
		resolvePendingAsks();
		chat.sendMessage(files.length ? { text, files } : { text });
	}

	// Claude-style edit: rewind the conversation to just before the edited
	// message and resend the new text — everything after is discarded.
	function editMessage(messageId: string, text: string) {
		if (busy) return;
		const index = chat.messages.findIndex((m) => m.id === messageId);
		if (index === -1) return;
		chat.messages = chat.messages.slice(0, index);
		chat.sendMessage({ text });
	}

	function regenerateLast() {
		if (!busy) chat.regenerate();
	}

	// Resolve an askUser tool call with the user's chosen option. Adding the
	// result satisfies sendAutomaticallyWhen, which re-sends so the agent
	// continues with the choice.
	function answerAsk(toolCallId: string, label: string) {
		chat.addToolResult({ tool: 'askUser', toolCallId, output: { selected: label } });
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
		textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
	}

	// Stick-to-bottom scrolling: while "pinned", any content growth (streaming
	// text, tool cards, charts resizing) keeps the view at the bottom via a
	// ResizeObserver. Scrolling up unpins; scrolling back down repins — the
	// view never fights the user.
	let contentEl = $state<HTMLElement | null>(null);
	let pinned = true;

	function handleScroll() {
		const el = scrollContainer;
		if (!el) return;
		pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
	}

	$effect(() => {
		const el = scrollContainer;
		const content = contentEl;
		if (!el || !content) return;
		el.scrollTop = el.scrollHeight; // opening a conversation lands at the end
		const ro = new ResizeObserver(() => {
			if (pinned) el.scrollTop = el.scrollHeight;
		});
		ro.observe(content);
		return () => ro.disconnect();
	});
</script>

<svelte:window
	onpaste={onPaste}
	ondragenter={onDragEnter}
	ondragleave={onDragLeave}
	ondragover={onDragOver}
	ondrop={onDrop}
/>

{#if dragging}
	<div
		class="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-[#faf9f5]/85 backdrop-blur-[2px]"
	>
		<div
			class="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-[#d97757] bg-white/80 px-12 py-10 text-[#bd5d3a]"
		>
			<Icon name="paperclip" size={32} />
			<p class="text-sm font-medium">{m.drop_to_attach()}</p>
		</div>
	</div>
{/if}

<!-- overflow-x-hidden: wide content (code, tables, diagrams) scrolls inside
     its own card — the page itself must never scroll horizontally.
     scrollbar-gutter reserves the scrollbar's width, so content never shifts
     sideways when the scrollbar appears/disappears mid-stream. -->
<main
	bind:this={scrollContainer}
	onscroll={handleScroll}
	class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]"
>
	<div bind:this={contentEl} class="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
		{#if chat.messages.length === 0}
			<div class="mt-24 text-center">
				<img src={logo} alt="" class="greeting-logo mx-auto mb-5 size-12" />
				<p class="text-2xl font-semibold text-neutral-800">
					{greeting({ username })}
				</p>
				<p class="mt-2 text-sm text-neutral-500">{greetingSub()}</p>
			</div>
		{/if}

		{#each chat.messages as message (message.id)}
			<!-- A render error in one message (malformed tool part, bad URL, …)
			     must not brick the whole app — the boundary swaps that message
			     for a fallback and keeps everything else interactive. -->
			<svelte:boundary onerror={(e) => console.error('message render failed:', e)}>
				<ChatMessage
					{message}
					username={loginName}
					{busy}
					isLast={message.id === chat.messages.at(-1)?.id}
					onEdit={editMessage}
					onRegenerate={regenerateLast}
					onAsk={answerAsk}
					onChatInstead={message.id === chat.messages.at(-1)?.id ? chatInstead : undefined}
				/>
				{#snippet failed(_error, reset)}
					<div
						class="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
					>
						<span class="min-w-0 flex-1">{m.message_render_error()}</span>
						<button
							onclick={reset}
							class="shrink-0 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium transition hover:bg-amber-100"
						>
							{m.try_again()}
						</button>
					</div>
				{/snippet}
			</svelte:boundary>
		{/each}

		{#if chat.status === 'submitted'}
			<div class="flex items-center gap-2 text-sm text-neutral-400">
				<span class="size-2 animate-bounce rounded-full bg-[#d97757]"></span>
				Thinking…
			</div>
		{/if}

		{#if chat.error}
			<div
				class="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
				role="alert"
			>
				<span>Something went wrong: {chat.error.message}</span>
				<button
					onclick={() => chat.regenerate()}
					class="shrink-0 rounded border border-red-300 px-2 py-1 text-xs font-medium hover:bg-red-100"
				>
					Retry
				</button>
			</div>
		{/if}
	</div>
</main>

<footer class="shrink-0 px-4 pt-1 pb-4 sm:px-6">
	{#if uploadNote}
		<div class="mx-auto mb-1.5 max-w-3xl">
			<span
				class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs
					{uploadNote.error
					? 'border-red-200 bg-red-50 text-red-700'
					: 'border-[#e3e0d5] bg-white text-neutral-600'}"
			>
				<Icon name={uploadNote.error ? 'x' : 'check'} size={12} />
				{uploadNote.error ? `${uploadNote.name}: ${uploadNote.error}` : m.upload_added({ name: uploadNote.name })}
			</span>
		</div>
	{/if}
	<div
		bind:this={composerEl}
		class="mx-auto max-w-3xl rounded-2xl border border-[#e3e0d5] bg-white p-2 shadow-sm focus-within:border-[#d97757]/50 focus-within:ring-2 focus-within:ring-[#d97757]/15"
	>
		{#if pendingAttachments.length > 0}
			<div class="flex flex-wrap gap-2 px-1 pt-1 pb-2">
				{#each pendingAttachments as att (att.id)}
					<div class="group relative">
						{#if att.kind === 'image'}
							<img
								src={att.dataUrl}
								alt={att.name}
								class="h-16 w-16 rounded-lg border border-[#e3e0d5] object-cover"
							/>
						{:else}
							<div
								class="flex h-16 w-36 flex-col justify-center gap-1 rounded-lg border border-[#e3e0d5] bg-[#faf9f5] px-3"
							>
								<span class="truncate text-xs font-medium text-neutral-700">{att.name}</span>
								<span class="w-fit rounded bg-[#d97757]/10 px-1.5 text-[10px] font-semibold text-[#bd5d3a]">
									PDF
								</span>
							</div>
						{/if}
						<button
							onclick={() => (pendingAttachments = pendingAttachments.filter((p) => p.id !== att.id))}
							class="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-neutral-700 text-white opacity-0 transition group-hover:opacity-100"
							title={m.remove_image()}
							aria-label={m.remove_image()}
						>
							<Icon name="x" size={11} />
						</button>
					</div>
				{/each}
			</div>
		{/if}
		<div class="flex items-end gap-1.5">
		<button
			type="button"
			onclick={() => fileInput?.click()}
			disabled={uploading}
			class="grid size-9 shrink-0 place-items-center rounded-full text-neutral-500 transition hover:bg-[#f0eee6] hover:text-neutral-700 disabled:opacity-50"
			title={m.attach_document()}
			aria-label={m.attach_document()}
		>
			<Icon name="paperclip" size={17} class={uploading ? 'animate-pulse' : ''} />
		</button>
		<input
			bind:this={fileInput}
			type="file"
			accept=".txt,.md,.markdown,.csv,.xlsx,.xls,.json,.sql,.log,.pdf,image/*"
			class="hidden"
			onchange={uploadFromInput}
		/>
		<textarea
			bind:this={textarea}
			bind:value={input}
			oninput={autogrow}
			onkeydown={handleKeydown}
			disabled={inputLocked}
			placeholder={inputLocked
				? m.composer_locked_placeholder()
				: hasKeyboard
					? m.composer_placeholder_keyboard()
					: m.composer_placeholder()}
			rows="1"
			class="max-h-[200px] min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] text-neutral-800 outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed"
		></textarea>
		{#if busy}
			<button
				type="button"
				onclick={stopRun}
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
				disabled={(!input.trim() && pendingAttachments.length === 0) || inputLocked}
				class="grid size-9 shrink-0 place-items-center rounded-full bg-[#d97757] text-white transition hover:bg-[#bd5d3a] disabled:opacity-40"
				title={m.send_message()}
				aria-label={m.send_message()}
			>
				<Icon name="arrow-up" size={17} />
			</button>
		{/if}
		</div>
		{#if models.length > 1}
			<div class="flex items-center px-1 pt-1.5">
				<ModelPicker {models} bind:value={selectedModel} onSelect={pickModel} anchor={composerEl} />
			</div>
		{/if}
	</div>
</footer>

<style>
	/* Empty-state logo: soft terracotta glow + a single gentle pop-in. */
	.greeting-logo {
		filter: drop-shadow(0 3px 8px rgba(217, 119, 87, 0.28));
		animation: logo-in 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
	}
	@keyframes logo-in {
		from {
			opacity: 0;
			transform: scale(0.8) translateY(6px);
		}
		to {
			opacity: 1;
			transform: scale(1) translateY(0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.greeting-logo {
			animation: none;
		}
	}
</style>

<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { getToken } from '$lib/session';
	import Icon from './Icon.svelte';

	interface DocMeta {
		id: string;
		name: string;
		uploadedAt: number;
		sheets?: string[];
	}

	// Files attached to THIS conversation — shown behind a top-right icon with
	// a popover, Claude-style.
	let { conversationId }: { conversationId: string } = $props();

	let docs = $state<DocMeta[]>([]);
	let open = $state(false);

	function authHeaders(): Record<string, string> {
		return { Authorization: `Bearer ${getToken() ?? ''}` };
	}

	async function refresh() {
		try {
			const res = await fetch(`/api/documents?conversation=${encodeURIComponent(conversationId)}`, {
				headers: authHeaders()
			});
			if (res.ok) docs = (await res.json()).documents;
		} catch {
			/* list stays as-is */
		}
	}

	$effect(() => {
		void conversationId;
		refresh();
		const handler = () => refresh();
		window.addEventListener('perguntai:docs-changed', handler);
		return () => window.removeEventListener('perguntai:docs-changed', handler);
	});

	async function remove(id: string) {
		await fetch(`/api/documents?id=${encodeURIComponent(id)}`, {
			method: 'DELETE',
			headers: authHeaders()
		});
		await refresh();
	}
</script>

<div class="relative">
	<button
		onclick={() => (open = !open)}
		class="relative grid size-9 place-items-center rounded-lg text-neutral-500 transition hover:bg-[#f0eee6] hover:text-neutral-700"
		title={m.files_in_chat()}
		aria-label={m.files_in_chat()}
	>
		<Icon name="file" size={17} />
		{#if docs.length > 0}
			<span
				class="absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-[#d97757] text-[10px] font-semibold text-white"
			>
				{docs.length}
			</span>
		{/if}
	</button>

	{#if open}
		<!-- click-away backdrop -->
		<button
			class="fixed inset-0 z-10 cursor-default"
			onclick={() => (open = false)}
			aria-label={m.close_files_panel()}
			tabindex="-1"
		></button>

		<div
			class="absolute top-full right-0 z-20 mt-1.5 w-72 rounded-xl border border-[#e3e0d5] bg-white p-2 shadow-lg"
		>
			<p class="px-2 py-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
				{m.files_in_chat()}
			</p>
			{#if docs.length === 0}
				<p class="px-2 py-3 text-xs text-neutral-400">
					{m.no_files()}
				</p>
			{:else}
				<ul class="max-h-64 space-y-0.5 overflow-y-auto">
					{#each docs as doc (doc.id)}
						<li
							class="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-neutral-700 hover:bg-[#faf9f5]"
						>
							<Icon name="file" size={14} class="shrink-0 text-neutral-400" />
							<span class="min-w-0 flex-1">
								<span class="block truncate" title={doc.name}>{doc.name}</span>
								{#if doc.sheets?.length}
									<span class="block truncate text-[11px] text-neutral-400">
										{doc.sheets.join(' · ')}
									</span>
								{/if}
							</span>
							<button
								onclick={() => remove(doc.id)}
								class="hidden shrink-0 rounded p-1 text-neutral-400 group-hover:block hover:bg-red-50 hover:text-red-600"
								title={m.remove_file({ name: doc.name })}
								aria-label={m.remove_file({ name: doc.name })}
							>
								<Icon name="trash" size={13} />
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>

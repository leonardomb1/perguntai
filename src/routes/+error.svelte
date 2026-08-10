<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { page } from '$app/state';

	const messages: Record<number, () => string> = {
		400: m.error_400,
		401: m.error_401,
		403: m.error_403,
		404: m.error_404,
		500: m.error_500,
		503: m.error_503
	};

	const hint = $derived((messages[page.status] ?? m.error_unknown)());
</script>

<svelte:head>
	<title>{page.status} · PerguntAI</title>
</svelte:head>

<main class="flex min-h-full flex-col items-center justify-center gap-4 bg-[#faf9f5] px-4">
	<p class="text-7xl font-bold tracking-tight text-[#d97757]">{page.status}</p>
	<div class="text-center">
		<p class="text-lg font-medium text-neutral-800">{hint}</p>
		{#if page.error?.message && page.error.message !== 'Not Found'}
			<p class="mt-1 max-w-md text-sm text-neutral-500">{page.error.message}</p>
		{/if}
	</div>
	<div class="mt-2 flex gap-3">
		<a
			href="/"
			class="rounded-xl bg-[#d97757] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#bd5d3a]"
		>
			{m.back_to_chat()}
		</a>
		<button
			onclick={() => location.reload()}
			class="rounded-xl border border-[#e3e0d5] bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
		>
			{m.try_again()}
		</button>
	</div>
</main>

<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import type { Pathname } from '$app/types';
	import { locales, localizeHref } from '$lib/paraglide/runtime';
	import '../app.css';
	import { navigating, page } from '$app/state';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

{#if navigating.to}
	<!-- Full-screen overlay while a page transition (load) is in flight -->

	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-[#faf9f5]/80 backdrop-blur-[1px]"
		role="status"
		aria-label="Loading"
	>
		<div class="flex flex-col items-center gap-3">
			<span
				class="size-8 animate-spin rounded-full border-[3px] border-[#e3e0d5] border-t-[#d97757]"
			></span>

			<span class="text-sm text-neutral-500">{m.loading()}</span>
		</div>
	</div>
{/if}

{@render children()}

<div style="display:none">
	{#each locales as locale (locale)}
		<a
			href={localizeHref(page.url.pathname, { locale }) as Pathname}
		>{locale}</a>
	{/each}
</div>

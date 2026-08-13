<script lang="ts">
	import { fly, scale } from 'svelte/transition';
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale, setLocale } from '$lib/paraglide/runtime';
	import { page } from '$app/state';
	import { clearSession } from '$lib/session';
	import logo from '$lib/assets/favicon.svg';

	/**
	 * Sign-in is delegated to authentik: this page no longer takes credentials,
	 * it just sends the browser to /auth/login, which starts the OIDC flow.
	 *
	 * Outcomes come back as query params rather than fetch results:
	 *   ?error=not_allowed | interrupted | unavailable
	 *   ?signedout          — arrived here from logout
	 */
	const status = $derived(page.url.searchParams.get('error'));
	const signedOut = $derived(page.url.searchParams.has('signedout'));
	const notAllowed = $derived(status === 'not_allowed');

	const message = $derived(
		status === 'interrupted'
			? m.login_interrupted()
			: status === 'unavailable'
				? m.login_service_unavailable()
				: status
					? m.login_failed()
					: null
	);

	// A stale bearer token would otherwise keep the app's client-side guard
	// believing there is still a session and bounce the user straight back.
	$effect(() => {
		if (signedOut || status) clearSession();
	});

	// After a deliberate sign-out, ask the IdP to re-authenticate: its session
	// outlives ours by design, so without this the button is answered silently
	// and it looks as though signing out did nothing.
	const signInHref = $derived(signedOut ? '/auth/login?prompt=login' : '/auth/login');
</script>

<svelte:head>
	<title>PerguntAI</title>
</svelte:head>

<main class="relative flex min-h-full items-center justify-center bg-[#faf9f5] px-4">
	<button
		onclick={() => setLocale(getLocale() === 'pt-br' ? 'en' : 'pt-br')}
		class="absolute top-4 right-4 rounded-lg border border-[#e3e0d5] bg-white px-2.5 py-1.5 text-xs font-semibold tracking-wide text-neutral-500 transition hover:text-neutral-800"
		title={m.change_language()}
		aria-label={m.change_language()}
	>
		{getLocale() === 'pt-br' ? 'EN' : 'PT'}
	</button>

	<div class="w-full max-w-sm" in:fly={{ y: 12, duration: 400 }}>
		<div class="mb-8 text-center">
			<img src={logo} alt="" class="logo-float mx-auto mb-4 size-14" />
			<h1 class="font-serif text-3xl font-semibold tracking-tight text-neutral-900">PerguntAI</h1>
			<p class="mt-1.5 font-serif text-[15px] text-neutral-500 italic">{m.login_tagline()}</p>
		</div>

		{#if notAllowed}
			<div
				in:scale={{ start: 0.95, duration: 300 }}
				class="rounded-2xl border border-[#e3e0d5] bg-white p-7 text-center shadow-sm"
			>
				<span
					class="preview-badge mb-4 inline-block rounded-full bg-[#d97757]/10 px-3 py-1 text-xs font-semibold tracking-widest text-[#bd5d3a] uppercase"
				>
					Preview
				</span>
				<h2 class="font-serif text-xl font-semibold text-neutral-900">
					{m.login_preview_title()}
				</h2>
				<p class="mt-2 text-sm leading-relaxed text-neutral-500">
					{m.login_preview_body({ username: '' })}
				</p>
				<a
					href="/auth/login?prompt=login"
					data-sveltekit-reload
					class="mt-5 inline-block rounded-xl border border-[#e3e0d5] bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition hover:bg-[#faf9f5]"
				>
					{m.login_preview_back()}
				</a>
			</div>
		{:else}
			<div class="space-y-4 rounded-2xl border border-[#e3e0d5] bg-white p-7 shadow-sm">
				<p class="text-center text-sm text-neutral-500">{m.login_subtitle()}</p>

				{#if signedOut}
					<p
						in:fly={{ y: -4, duration: 200 }}
						class="rounded-xl bg-[#faf9f5] px-3.5 py-2.5 text-center text-sm text-neutral-600"
						role="status"
					>
						{m.login_signed_out()}
					</p>
				{:else if message}
					<p
						in:fly={{ y: -4, duration: 200 }}
						class="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700"
						role="alert"
					>
						{message}
					</p>
				{/if}

				<a
					href={signInHref}
					data-sveltekit-reload
					class="block w-full rounded-xl bg-[#d97757] px-4 py-2.5 text-center text-sm font-medium text-white shadow-sm transition hover:bg-[#bd5d3a]"
				>
					{m.login_submit()}
				</a>
			</div>
		{/if}
	</div>
</main>

<style>
	.logo-float {
		animation: float 5s ease-in-out infinite;
		filter: drop-shadow(0 4px 10px rgba(217, 119, 87, 0.25));
	}
	@keyframes float {
		0%,
		100% {
			transform: translateY(0);
		}
		50% {
			transform: translateY(-6px);
		}
	}
	.preview-badge {
		animation: badge-pulse 2.4s ease-in-out infinite;
	}
	@keyframes badge-pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.55;
		}
	}
</style>

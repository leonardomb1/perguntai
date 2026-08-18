<script lang="ts">
	import { fly, scale } from 'svelte/transition';
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale, setLocale } from '$lib/paraglide/runtime';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { clearSession, saveSession } from '$lib/session';
	import logo from '$lib/assets/favicon.svg';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/**
	 * Two ways in, each present only when configured: a username + password
	 * form (LDAPS, via POST /api/auth/login) and an SSO button that sends the
	 * browser to /auth/login to start the OIDC flow.
	 *
	 * SSO outcomes come back as query params rather than fetch results:
	 *   ?error=not_allowed | interrupted | unavailable
	 *   ?signedout          — arrived here from logout
	 */
	const status = $derived(page.url.searchParams.get('error'));
	const signedOut = $derived(page.url.searchParams.has('signedout'));

	let username = $state('');
	let password = $state('');
	let formError = $state<string | null>(null);
	let loading = $state(false);
	let formNotAllowed = $state(false);
	const notAllowed = $derived(formNotAllowed || status === 'not_allowed');

	const flowMessage = $derived(
		status === 'interrupted'
			? m.login_interrupted()
			: status === 'unavailable'
				? m.login_service_unavailable()
				: status && status !== 'not_allowed'
					? m.login_failed()
					: null
	);
	// A form outcome is fresher than whatever the URL says.
	const message = $derived(formError ?? flowMessage);

	// A stale bearer token would otherwise keep the app's client-side guard
	// believing there is still a session and bounce the user straight back.
	$effect(() => {
		if (signedOut || status) clearSession();
	});

	// After a deliberate sign-out, ask the IdP to re-authenticate: its session
	// outlives ours by design, so without this the button is answered silently
	// and it looks as though signing out did nothing.
	const ssoHref = $derived(signedOut ? '/auth/login?prompt=login' : '/auth/login');

	function rejectionMessage(code: string | undefined, httpStatus: number): string {
		switch (code) {
			case 'locked':
				return m.login_locked();
			case 'disabled':
				return m.login_disabled();
			case 'expired':
				return m.login_expired();
			case 'throttled':
				return m.login_throttled();
		}
		return httpStatus === 401
			? m.login_invalid()
			: httpStatus === 503
				? m.login_service_unavailable()
				: m.login_failed();
	}

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (loading) return;
		formError = null;
		loading = true;
		try {
			const res = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username, password })
			});
			const body = (await res.json().catch(() => ({}))) as { code?: string };
			if (!res.ok) {
				if (res.status === 403 && body.code === 'not_in_allowlist') {
					formNotAllowed = true;
					return;
				}
				formError = rejectionMessage(body.code, res.status);
				return;
			}
			const { token, displayName } = body as { token: string; displayName: string | null };
			saveSession(token, displayName);
			await goto('/');
		} catch {
			formError = m.login_unreachable();
		} finally {
			loading = false;
		}
	}
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
					href="/login"
					data-sveltekit-reload
					class="mt-5 inline-block rounded-xl border border-[#e3e0d5] bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition hover:bg-[#faf9f5]"
				>
					{m.login_preview_back()}
				</a>
			</div>
		{:else}
			<div class="space-y-4 rounded-2xl border border-[#e3e0d5] bg-white p-7 shadow-sm">
				<p class="text-center text-sm text-neutral-500">{m.login_subtitle()}</p>

				{#if message}
					<p
						in:fly={{ y: -4, duration: 200 }}
						class="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700"
						role="alert"
					>
						{message}
					</p>
				{:else if signedOut}
					<p
						in:fly={{ y: -4, duration: 200 }}
						class="rounded-xl bg-[#faf9f5] px-3.5 py-2.5 text-center text-sm text-neutral-600"
						role="status"
					>
						{m.login_signed_out()}
					</p>
				{/if}

				{#if data.methods.ldap}
					<form onsubmit={handleSubmit} class="space-y-3">
						<label class="block">
							<span class="mb-1 block text-xs font-medium text-neutral-500">{m.login_username()}</span>
							<input
								type="text"
								name="username"
								bind:value={username}
								autocomplete="username"
								autocapitalize="none"
								spellcheck="false"
								required
								class="w-full rounded-xl border border-[#e3e0d5] bg-[#faf9f5] px-3.5 py-2.5 text-sm text-neutral-900 outline-none transition focus:border-[#d97757] focus:bg-white"
							/>
						</label>
						<label class="block">
							<span class="mb-1 block text-xs font-medium text-neutral-500">{m.login_password()}</span>
							<input
								type="password"
								name="password"
								bind:value={password}
								autocomplete="current-password"
								required
								class="w-full rounded-xl border border-[#e3e0d5] bg-[#faf9f5] px-3.5 py-2.5 text-sm text-neutral-900 outline-none transition focus:border-[#d97757] focus:bg-white"
							/>
						</label>
						<button
							type="submit"
							disabled={loading}
							class="block w-full rounded-xl bg-[#d97757] px-4 py-2.5 text-center text-sm font-medium text-white shadow-sm transition hover:bg-[#bd5d3a] disabled:cursor-default disabled:opacity-60"
						>
							{loading ? m.login_submitting() : m.login_submit()}
						</button>
					</form>
				{/if}

				{#if data.methods.ldap && data.methods.oidc}
					<div class="flex items-center gap-3 text-[11px] font-medium tracking-widest text-neutral-400 uppercase">
						<span class="h-px flex-1 bg-[#e3e0d5]"></span>
						{m.login_or()}
						<span class="h-px flex-1 bg-[#e3e0d5]"></span>
					</div>
				{/if}

				{#if data.methods.oidc}
					<a
						href={ssoHref}
						data-sveltekit-reload
						class={data.methods.ldap
							? 'block w-full rounded-xl border border-[#e3e0d5] bg-white px-4 py-2.5 text-center text-sm font-medium text-neutral-700 transition hover:bg-[#faf9f5]'
							: 'block w-full rounded-xl bg-[#d97757] px-4 py-2.5 text-center text-sm font-medium text-white shadow-sm transition hover:bg-[#bd5d3a]'}
					>
						{data.methods.ldap ? m.login_sso() : m.login_submit()}
					</a>
				{/if}

				{#if !data.methods.ldap && !data.methods.oidc}
					<p class="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700" role="alert">
						{m.login_no_method()}
					</p>
				{/if}
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

<script lang="ts">
	import { fly, scale } from 'svelte/transition';
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale, setLocale } from '$lib/paraglide/runtime';
	import { goto } from '$app/navigation';
	import { saveSession } from '$lib/session';
	import logo from '$lib/assets/favicon.svg';

	let username = $state('');
	let password = $state('');
	let error = $state<string | null>(null);
	let loading = $state(false);
	let notAllowed = $state(false);

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (loading) return;
		error = null;
		loading = true;
		try {
			const res = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username, password })
			});
			const data = await res.json();
			if (!res.ok) {
				if (res.status === 403 && data.code === 'not_in_allowlist') {
					notAllowed = true;
					return;
				}
				error =
					res.status === 401
						? m.login_invalid()
						: res.status === 503
							? m.login_service_unavailable()
							: (data.error ?? m.login_failed());
				return;
			}
			saveSession(data.token, data.displayName);
			await goto('/');
		} catch {
			error = m.login_unreachable();
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
					{m.login_preview_body({ username })}
				</p>
				<button
					onclick={() => (notAllowed = false)}
					class="mt-5 rounded-xl border border-[#e3e0d5] bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition hover:bg-[#faf9f5]"
				>
					{m.login_preview_back()}
				</button>
			</div>
		{:else}
			<form
				onsubmit={handleSubmit}
				class="space-y-4 rounded-2xl border border-[#e3e0d5] bg-white p-7 shadow-sm"
			>
				<div>
					<label for="username" class="mb-1.5 block text-sm font-medium text-neutral-700">
						{m.login_username()}
					</label>
					<input
						id="username"
						type="text"
						bind:value={username}
						required
						autocomplete="username"
						class="w-full rounded-xl border border-neutral-300 px-3.5 py-2.5 text-sm transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
					/>
				</div>

				<div>
					<label for="password" class="mb-1.5 block text-sm font-medium text-neutral-700">
						{m.login_password()}
					</label>
					<input
						id="password"
						type="password"
						bind:value={password}
						required
						autocomplete="current-password"
						class="w-full rounded-xl border border-neutral-300 px-3.5 py-2.5 text-sm transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
					/>
				</div>

				{#if error}
					<p
						in:fly={{ y: -4, duration: 200 }}
						class="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm text-red-700"
						role="alert"
					>
						{error}
					</p>
				{/if}

				<button
					type="submit"
					disabled={loading}
					class="w-full rounded-xl bg-[#d97757] px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-[#bd5d3a] disabled:opacity-50"
				>
					{loading ? m.login_submitting() : m.login_submit()}
				</button>
			</form>
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

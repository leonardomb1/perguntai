<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale, setLocale } from '$lib/paraglide/runtime';
	import Icon from './Icon.svelte';
	import { saveSettings, type PublicSettings } from '$lib/settings';
	import logo from '$lib/assets/favicon.svg';

	let {
		username,
		onDone
	}: {
		username: string;
		/** Called with the saved settings once onboarding completes (or is skipped). */
		onDone: (settings: PublicSettings | null) => void;
	} = $props();

	let step = $state(0);
	const TOTAL = 3;

	let fullName = $state('');
	let displayName = $state('');
	let windmillToken = $state('');
	let saving = $state(false);

	async function finish(skipAll = false) {
		if (saving) return;
		saving = true;
		const updated = await saveSettings(
			skipAll
				? { onboarded: true }
				: {
						fullName,
						displayName,
						...(windmillToken.trim() ? { windmillToken: windmillToken.trim() } : {}),
						onboarded: true
					}
		);
		saving = false;
		// Even if the save failed, let the user into the app — onboarding will
		// simply be offered again next session.
		onDone(updated);
	}
</script>

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-[#faf9f5]/95 p-4 backdrop-blur-sm"
	transition:fade={{ duration: 200 }}
>
	<div class="w-full max-w-md">
		{#key step}
			<div
				in:fly={{ x: 24, duration: 250 }}
				class="rounded-2xl border border-[#e3e0d5] bg-white p-8 shadow-lg"
			>
				{#if step === 0}
					<img src={logo} alt="" class="mx-auto mb-4 size-14" />
					<h1 class="text-center font-serif text-2xl font-semibold tracking-tight text-neutral-900">
						{m.onboarding_welcome_title()}
					</h1>
					<p class="mt-2 text-center text-sm leading-relaxed text-neutral-500">
						{m.onboarding_welcome_body()}
					</p>
					<div class="mt-4 flex justify-center">
						<div class="flex rounded-lg border border-[#e3e0d5] p-0.5">
							{#each [{ locale: 'pt-br', label: 'Português' }, { locale: 'en', label: 'English' }] as opt (opt.locale)}
								<button
									onclick={() => getLocale() !== opt.locale && setLocale(opt.locale as 'pt-br' | 'en')}
									class="rounded-md px-3 py-1.5 text-xs font-semibold transition
										{getLocale() === opt.locale
										? 'bg-[#d97757] text-white'
										: 'text-neutral-500 hover:text-neutral-800'}"
								>
									{opt.label}
								</button>
							{/each}
						</div>
					</div>
					<button
						onclick={() => (step = 1)}
						class="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-[#d97757] px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-[#bd5d3a]"
					>
						{m.onboarding_start()}
						<Icon name="arrow-right" size={15} />
					</button>
					<button
						onclick={() => finish(true)}
						disabled={saving}
						class="mt-2 w-full py-1.5 text-center text-xs text-neutral-400 transition hover:text-neutral-600"
					>
						{m.onboarding_skip()}
					</button>
				{:else if step === 1}
					<div class="mb-4 flex size-10 items-center justify-center rounded-xl bg-[#d97757]/10 text-[#bd5d3a]">
						<Icon name="user" size={20} />
					</div>
					<h2 class="font-serif text-xl font-semibold text-neutral-900">
						{m.onboarding_profile_title()}
					</h2>
					<p class="mt-1.5 text-sm text-neutral-500">{m.onboarding_profile_body()}</p>

					<label for="ob-fullname" class="mt-5 mb-1.5 block text-sm font-medium text-neutral-700">
						{m.settings_full_name()}
					</label>
					<!-- svelte-ignore a11y_autofocus -->
					<input
						id="ob-fullname"
						type="text"
						bind:value={fullName}
						maxlength="80"
						autofocus
						placeholder={username}
						class="w-full rounded-xl border border-neutral-300 px-3.5 py-2.5 text-sm transition placeholder:text-neutral-400 focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
					/>

					<label for="ob-displayname" class="mt-4 mb-1.5 block text-sm font-medium text-neutral-700">
						{m.settings_call_you()}
					</label>
					<input
						id="ob-displayname"
						type="text"
						bind:value={displayName}
						maxlength="80"
						placeholder={fullName.split(' ')[0] || username}
						class="w-full rounded-xl border border-neutral-300 px-3.5 py-2.5 text-sm transition placeholder:text-neutral-400 focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
					/>

					<button
						onclick={() => (step = 2)}
						class="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-[#d97757] px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-[#bd5d3a]"
					>
						{m.onboarding_next()}
						<Icon name="arrow-right" size={15} />
					</button>
				{:else}
					<div class="mb-4 flex size-10 items-center justify-center rounded-xl bg-[#d97757]/10 text-[#bd5d3a]">
						<Icon name="zap" size={20} />
					</div>
					<h2 class="font-serif text-xl font-semibold text-neutral-900">
						{m.onboarding_windmill_title()}
					</h2>
					<p class="mt-1.5 text-sm leading-relaxed text-neutral-500">
						{m.onboarding_windmill_body()}
					</p>
					<p class="mt-1.5 text-xs text-neutral-400">{m.settings_windmill_hint()}</p>

					<label for="ob-windmill" class="mt-5 mb-1.5 block text-sm font-medium text-neutral-700">
						{m.settings_windmill_token()}
						<span class="font-normal text-neutral-400">· {m.onboarding_optional()}</span>
					</label>
					<input
						id="ob-windmill"
						type="password"
						bind:value={windmillToken}
						maxlength="200"
						autocomplete="off"
						class="w-full rounded-xl border border-neutral-300 px-3.5 py-2.5 font-mono text-sm transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
					/>

					<button
						onclick={() => finish()}
						disabled={saving}
						class="mt-6 w-full rounded-xl bg-[#d97757] px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-[#bd5d3a] disabled:opacity-50"
					>
						{saving ? m.onboarding_finishing() : m.onboarding_finish()}
					</button>
					<button
						onclick={() => (step = 1)}
						class="mt-2 w-full py-1.5 text-center text-xs text-neutral-400 transition hover:text-neutral-600"
					>
						{m.onboarding_back()}
					</button>
				{/if}

				<!-- Progress dots -->
				<div class="mt-6 flex justify-center gap-1.5">
					{#each Array(TOTAL) as _, i (i)}
						<span
							class="size-1.5 rounded-full transition-colors {i === step
								? 'bg-[#d97757]'
								: 'bg-[#e3e0d5]'}"
						></span>
					{/each}
				</div>
			</div>
		{/key}
	</div>
</div>

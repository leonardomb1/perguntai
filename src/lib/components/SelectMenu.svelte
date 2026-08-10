<script lang="ts" generics="T extends { value: string; label: string; hint?: string }">
	import Icon from './Icon.svelte';
	import { clickOutside } from '$lib/actions/clickOutside';
	import { placeMenu } from '$lib/floating';
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import type { Snippet } from 'svelte';

	let {
		options,
		value = $bindable(),
		onSelect,
		align = 'left',
		direction = 'down',
		disabled = false,
		title,
		triggerClass = '',
		menuClass = '',
		leading
	}: {
		options: T[];
		value: string;
		onSelect?: (value: string) => void;
		align?: 'left' | 'right';
		direction?: 'up' | 'down';
		disabled?: boolean;
		title?: string;
		triggerClass?: string;
		menuClass?: string;
		/** Optional per-option adornment (e.g. a provider logo) before the label. */
		leading?: Snippet<[T]>;
	} = $props();

	let open = $state(false);
	let triggerEl = $state<HTMLElement | null>(null);
	let menuEl = $state<HTMLElement | null>(null);
	let pos = $state<{ left: number; top: number; minWidth: number } | null>(null);
	const current = $derived(options.find((o) => o.value === value) ?? options[0]);

	function choose(v: string) {
		value = v;
		open = false;
		onSelect?.(v);
	}

	// Position the fixed menu against the trigger; re-place on scroll/resize so it
	// tracks the trigger inside a scrolling modal.
	$effect(() => {
		if (!open || !triggerEl) {
			pos = null;
			return;
		}
		const reposition = () => {
			if (!triggerEl) return;
			pos = placeMenu(triggerEl.getBoundingClientRect(), menuEl?.offsetHeight ?? 0, {
				align,
				direction
			});
		};
		reposition();
		requestAnimationFrame(reposition); // refine once the menu height is known
		window.addEventListener('scroll', reposition, true);
		window.addEventListener('resize', reposition);
		return () => {
			window.removeEventListener('scroll', reposition, true);
			window.removeEventListener('resize', reposition);
		};
	});
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && (open = false)} />

<div class="relative" use:clickOutside={{ enabled: () => open, onOutside: () => (open = false) }}>
	<button
		bind:this={triggerEl}
		type="button"
		{disabled}
		{title}
		onclick={() => (open = !open)}
		aria-haspopup="listbox"
		aria-expanded={open}
		class="flex items-center gap-1.5 rounded-full border bg-white py-1 pr-1.5 pl-2.5 text-xs font-medium text-neutral-600 transition hover:bg-[#faf9f5] disabled:cursor-default disabled:opacity-50 disabled:hover:bg-white {open
			? 'border-[#d97757]/40'
			: 'border-[#e3e0d5]'} {triggerClass}"
	>
		{#if current}
			{#if leading}{@render leading(current)}{/if}
			<span>{current.label}</span>
		{/if}
		<Icon
			name="chevron-down"
			size={12}
			class="text-neutral-400 transition-transform {open ? 'rotate-180' : ''}"
		/>
	</button>

	{#if open}
		<div
			bind:this={menuEl}
			role="listbox"
			in:scale={{ duration: 130, start: 0.95, opacity: 0, easing: cubicOut }}
			style="position:fixed; left:{pos?.left ?? 0}px; top:{pos?.top ??
				0}px; min-width:{pos?.minWidth ?? 176}px; max-height:min(60vh,22rem); transform-origin:{direction ===
			'up'
				? 'bottom'
				: 'top'} {align === 'right' ? 'right' : 'left'}; visibility:{pos ? 'visible' : 'hidden'}"
			class="z-50 overflow-y-auto rounded-2xl border border-[#e3e0d5] bg-white p-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.12)] {menuClass}"
		>
			{#each options as o (o.value)}
				<button
					type="button"
					role="option"
					aria-selected={o.value === value}
					onclick={() => choose(o.value)}
					class="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition {o.value ===
					value
						? 'bg-[#d97757]/10'
						: 'hover:bg-[#faf9f5]'}"
				>
					{#if leading}{@render leading(o)}{/if}
					<span class="min-w-0 flex-1">
						<span class="block text-sm font-medium text-neutral-800">{o.label}</span>
						{#if o.hint}
							<span class="block truncate text-xs text-neutral-500">{o.hint}</span>
						{/if}
					</span>
					{#if o.value === value}
						<Icon name="check" size={15} class="shrink-0 text-[#bd5d3a]" />
					{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>

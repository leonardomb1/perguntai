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
		anchor = null,
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
		/**
		 * Element to position the menu against instead of the trigger — e.g. the
		 * composer card the trigger lives in, so the menu opens clear of it
		 * rather than floating over it.
		 */
		anchor?: HTMLElement | null;
		/** Optional per-option adornment (e.g. a provider logo) before the label. */
		leading?: Snippet<[T]>;
	} = $props();

	let open = $state(false);
	let triggerEl = $state<HTMLElement | null>(null);
	let menuEl = $state<HTMLElement | null>(null);
	let pos = $state<{ left: number; top: number; minWidth: number } | null>(null);
	let optionEls: (HTMLButtonElement | null)[] = [];
	const current = $derived(options.find((o) => o.value === value) ?? options[0]);

	function choose(v: string) {
		value = v;
		open = false;
		triggerEl?.focus();
		onSelect?.(v);
	}

	// ARIA listbox keyboard pattern: focus roves through the options with the
	// arrow keys; Enter/Space activate the focused option natively (they're
	// buttons); Escape returns focus to the trigger.
	$effect(() => {
		if (!open) return;
		requestAnimationFrame(() => {
			const idx = options.findIndex((o) => o.value === value);
			optionEls[idx >= 0 ? idx : 0]?.focus();
		});
	});

	function onMenuKeydown(e: KeyboardEvent) {
		const focusable = optionEls.filter((el): el is HTMLButtonElement => !!el);
		const idx = focusable.indexOf(document.activeElement as HTMLButtonElement);
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const dir = e.key === 'ArrowDown' ? 1 : -1;
			focusable[(idx + dir + focusable.length) % focusable.length]?.focus();
		} else if (e.key === 'Home' || e.key === 'End') {
			e.preventDefault();
			focusable[e.key === 'Home' ? 0 : focusable.length - 1]?.focus();
		} else if (e.key === 'Escape') {
			open = false;
			triggerEl?.focus();
		} else if (e.key === 'Tab') {
			open = false;
		}
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
			pos = placeMenu((anchor ?? triggerEl).getBoundingClientRect(), menuEl?.offsetHeight ?? 0, {
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
		onkeydown={(e) => {
			if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
				e.preventDefault();
				open = true;
			}
		}}
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
			tabindex={-1}
			onkeydown={onMenuKeydown}
			in:scale={{ duration: 130, start: 0.95, opacity: 0, easing: cubicOut }}
			style="position:fixed; left:{pos?.left ?? 0}px; top:{pos?.top ??
				0}px; min-width:{pos?.minWidth ?? 176}px; max-height:min(60vh,22rem); transform-origin:{direction ===
			'up'
				? 'bottom'
				: 'top'} {align === 'right' ? 'right' : 'left'}; visibility:{pos ? 'visible' : 'hidden'}"
			class="z-50 overflow-y-auto rounded-2xl border border-[#e3e0d5] bg-white p-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.07)] {menuClass}"
		>
			{#each options as o, i (o.value)}
				<!-- Highlight (hover/keyboard focus) is transient "where you are";
				     the check mark is the persistent "what's chosen" — never both
				     as a background, so only one row ever looks active. The check
				     slot is always rendered (invisible when unselected) so rows
				     keep identical geometry. -->
				<button
					bind:this={optionEls[i]}
					type="button"
					role="option"
					tabindex={-1}
					aria-selected={o.value === value}
					onclick={() => choose(o.value)}
					class="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition outline-none hover:bg-[#e3e0d5]/40 focus:bg-[#e3e0d5]/40"
				>
					{#if leading}{@render leading(o)}{/if}
					<span class="min-w-0 flex-1">
						<span class="block text-sm font-medium text-neutral-800">{o.label}</span>
						{#if o.hint}
							<span class="block truncate text-xs text-neutral-500">{o.hint}</span>
						{/if}
					</span>
					<Icon
						name="check"
						size={15}
						class="shrink-0 {o.value === value ? 'text-[#bd5d3a]' : 'invisible'}"
					/>
				</button>
			{/each}
		</div>
	{/if}
</div>

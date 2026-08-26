<script lang="ts">
	import Icon from './Icon.svelte';

	/**
	 * A small ⓘ that reveals its explanation on hover/focus — Azure-portal
	 * style. Replaces the paragraph-under-every-title pattern so cards lead
	 * with content, not prose. Use align="right" when the icon sits near the
	 * right edge so the bubble grows leftward instead of clipping.
	 */
	let { text, align = 'center' }: { text: string; align?: 'center' | 'right' } = $props();
</script>

<span class="group relative inline-flex align-middle">
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<span
		tabindex={0}
		role="note"
		aria-label={text}
		class="grid size-4 cursor-help place-items-center text-neutral-400 transition group-hover:text-neutral-600 focus:outline-none"
	>
		<Icon name="info" size={14} />
	</span>
	<span
		class="pointer-events-none absolute top-full z-40 mt-1.5 w-72 rounded-lg bg-neutral-800 px-3 py-2 text-xs leading-relaxed font-normal text-white normal-case opacity-0 shadow-lg transition group-hover:opacity-100 group-focus-within:opacity-100 {align ===
		'right'
			? 'right-0'
			: 'left-1/2 -translate-x-1/2'}"
	>
		{text}
	</span>
</span>

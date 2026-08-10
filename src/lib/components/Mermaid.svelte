<script lang="ts">
	import { tick } from 'svelte';
	import { fade } from 'svelte/transition';
	import { m } from '$lib/paraglide/messages.js';
	import { browser } from '$app/environment';
	import { INK } from '$lib/palette';
	import Icon from './Icon.svelte';
	import { canCopyImage, copyImage, downloadBlob, pngFilename, svgToPng } from '$lib/image-export';

	let { code, title }: { code: string; title: string } = $props();

	let svg = $state<string | null>(null);
	let error = $state<string | null>(null);
	let expanded = $state(false);

	// --- zoom inside the expanded view ---
	const ZOOM_MAX = 4;
	const ZOOM_STEP = 1.5;
	let zoom = $state(1);
	let zoomPane = $state<HTMLElement | null>(null);

	function openExpanded() {
		zoom = 1;
		expanded = true;
	}

	/** Zoom keeping the given viewport point (defaults to center) anchored. */
	async function zoomTo(next: number, clientX?: number, clientY?: number) {
		const pane = zoomPane;
		const target = Math.min(ZOOM_MAX, Math.max(1, next));
		if (!pane || target === zoom) return;
		const rect = pane.getBoundingClientRect();
		const px = (clientX ?? rect.left + rect.width / 2) - rect.left;
		const py = (clientY ?? rect.top + rect.height / 2) - rect.top;
		const factor = target / zoom;
		const cx = (pane.scrollLeft + px) * factor;
		const cy = (pane.scrollTop + py) * factor;
		zoom = target;
		await tick();
		pane.scrollLeft = cx - px;
		pane.scrollTop = cy - py;
	}

	// Magnifier behavior: click zooms in step by step; at max, click resets.
	function onDiagramClick(e: MouseEvent) {
		if (zoom >= ZOOM_MAX) void zoomTo(1);
		else void zoomTo(zoom * ZOOM_STEP, e.clientX, e.clientY);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') expanded = false;
	}

	// --- export as image ---
	const copySupported = canCopyImage();
	let imageCopied = $state(false);

	async function downloadPng() {
		const blob = svg && (await svgToPng(svg, INK.surface));
		if (blob) downloadBlob(blob, pngFilename(title));
	}
	async function copyPng() {
		const blob = svg && (await svgToPng(svg, INK.surface));
		if (blob && (await copyImage(blob))) {
			imageCopied = true;
			setTimeout(() => (imageCopied = false), 1500);
		}
	}

	let counter = 0;

	$effect(() => {
		if (!browser || !code) return;
		let cancelled = false;

		(async () => {
			try {
				// Dynamic import keeps mermaid (~1 MB) out of the main bundle.
				const mermaid = (await import('mermaid')).default;
				mermaid.initialize({
					startOnLoad: false,
					theme: 'base',
					// Plain SVG <text> labels instead of <foreignObject> HTML:
					// foreignObject taints any canvas that draws the SVG, which
					// would break the PNG download/copy export. Top-level key —
					// mermaid ≥11 deprecated flowchart.htmlLabels and the default
					// (true) shadows it.
					htmlLabels: false,
					fontFamily: "'DM Sans Variable', ui-sans-serif, system-ui, sans-serif",
					themeVariables: {
						primaryColor: '#f0eee6',
						primaryTextColor: '#262624',
						primaryBorderColor: '#c3c2b7',
						lineColor: '#898781',
						secondaryColor: '#fcfcfb',
						tertiaryColor: '#faf9f5',
						fontSize: '14px'
					}
				});
				// Parse first for a clean error instead of a broken render.
				await mermaid.parse(code);
				const { svg: rendered } = await mermaid.render(`mermaid-${Date.now()}-${counter++}`, code);
				if (!cancelled) {
					svg = rendered;
					error = null;
				}
			} catch (e) {
				if (!cancelled) {
					error = e instanceof Error ? e.message : 'Invalid diagram';
					svg = null;
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	});
</script>

<svelte:window onkeydown={onKeydown} />

<figure
	class="rounded-xl border border-neutral-200 p-4"
	style:background-color={INK.surface}
	aria-label={title}
>
	<figcaption
		class="mb-3 flex items-center justify-between gap-2 text-sm font-semibold"
		style:color={INK.primary}
	>
		{title}
		{#if svg}
			<span class="flex shrink-0 items-center gap-0.5">
				{#if copySupported}
					<button
						onclick={copyPng}
						class="rounded-lg p-1.5 text-neutral-400 transition hover:bg-white hover:text-neutral-700"
						title={m.copy_image()}
						aria-label={m.copy_image()}
					>
						<Icon name={imageCopied ? 'check' : 'copy'} size={15} />
					</button>
				{/if}
				<button
					onclick={downloadPng}
					class="rounded-lg p-1.5 text-neutral-400 transition hover:bg-white hover:text-neutral-700"
					title={m.download_image()}
					aria-label={m.download_image()}
				>
					<Icon name="download" size={15} />
				</button>
				<button
					onclick={openExpanded}
					class="rounded-lg p-1.5 text-neutral-400 transition hover:bg-white hover:text-neutral-700"
					title={m.diagram_expand()}
					aria-label={m.diagram_expand()}
				>
					<Icon name="maximize" size={15} />
				</button>
			</span>
		{/if}
	</figcaption>

	{#if error}
		<p class="mb-2 text-sm text-red-600">{m.diagram_failed({ error })}</p>
		<pre class="overflow-x-auto rounded bg-[#faf9f5] p-2 text-xs">{code}</pre>
	{:else if svg}
		<!-- SVG is generated locally by mermaid from the diagram source. -->
		<button
			onclick={openExpanded}
			class="flex w-full cursor-zoom-in justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full"
			title={m.diagram_expand()}
		>
			{@html svg}
		</button>
	{:else}
		<div class="flex h-24 items-center justify-center text-sm text-neutral-400">
			{m.diagram_rendering()}
		</div>
	{/if}
</figure>

{#if expanded && svg}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-50 flex flex-col bg-[#faf9f5]/97 p-4 backdrop-blur-sm sm:p-8"
		transition:fade={{ duration: 150 }}
		onclick={(e) => e.target === e.currentTarget && (expanded = false)}
		role="dialog"
		aria-modal="true"
		aria-label={title}
		tabindex="-1"
	>
		<div class="mb-3 flex shrink-0 items-center justify-between gap-3">
			<span class="truncate text-base font-semibold text-neutral-800">{title}</span>
			<div class="flex items-center gap-1">
				{#if copySupported}
					<button
						onclick={copyPng}
						class="rounded-lg border border-[#e3e0d5] bg-white p-2 text-neutral-500 transition hover:text-neutral-800"
						title={m.copy_image()}
						aria-label={m.copy_image()}
					>
						<Icon name={imageCopied ? 'check' : 'copy'} size={16} />
					</button>
				{/if}
				<button
					onclick={downloadPng}
					class="mr-2 rounded-lg border border-[#e3e0d5] bg-white p-2 text-neutral-500 transition hover:text-neutral-800"
					title={m.download_image()}
					aria-label={m.download_image()}
				>
					<Icon name="download" size={16} />
				</button>
				<button
					onclick={() => zoomTo(zoom / ZOOM_STEP)}
					disabled={zoom <= 1}
					class="rounded-lg border border-[#e3e0d5] bg-white p-2 text-neutral-500 transition hover:text-neutral-800 disabled:opacity-40"
					title={m.zoom_out()}
					aria-label={m.zoom_out()}
				>
					<Icon name="zoom-out" size={16} />
				</button>
				<span class="w-12 text-center text-xs font-medium text-neutral-500 tabular-nums">
					{Math.round(zoom * 100)}%
				</span>
				<button
					onclick={() => zoomTo(zoom * ZOOM_STEP)}
					disabled={zoom >= ZOOM_MAX}
					class="rounded-lg border border-[#e3e0d5] bg-white p-2 text-neutral-500 transition hover:text-neutral-800 disabled:opacity-40"
					title={m.zoom_in()}
					aria-label={m.zoom_in()}
				>
					<Icon name="zoom-in" size={16} />
				</button>
				<button
					onclick={() => (expanded = false)}
					class="ml-2 rounded-lg border border-[#e3e0d5] bg-white p-2 text-neutral-500 transition hover:text-neutral-800"
					title={m.settings_close()}
					aria-label={m.settings_close()}
				>
					<Icon name="x" size={18} />
				</button>
			</div>
		</div>
		<!-- Full-viewport render: undo mermaid's inline max-width so the SVG
		     scales to the zoomed width; scrolling pans huge diagrams. Click acts
		     as a magnifier — zoom in anchored on the clicked point, reset at max. -->
		<div
			bind:this={zoomPane}
			class="min-h-0 flex-1 overflow-auto rounded-xl border border-[#e3e0d5] bg-white"
		>
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
			<div
				onclick={onDiagramClick}
				class="p-6 [&_svg]:h-auto [&_svg]:w-full [&_svg]:!max-w-none
					{zoom >= ZOOM_MAX ? 'cursor-zoom-out' : 'cursor-zoom-in'}"
				style:width="{zoom * 100}%"
			>
				{@html svg}
			</div>
		</div>
	</div>
{/if}

<script module lang="ts">
	export type ChartType =
		| 'bar'
		| 'horizontalBar'
		| 'line'
		| 'area'
		| 'pie'
		| 'doughnut'
		| 'polarArea'
		| 'scatter'
		| 'bubble'
		| 'radar'
		| 'heatmap';

	export type DataPoint = { x: number; y: number; r?: number };

	export interface ChartSpec {
		type: ChartType;
		title: string;
		labels?: string[];
		datasets: { label: string; data: number[] | DataPoint[] }[];
		stacked?: boolean;
		xLabel?: string;
		yLabel?: string;
	}
</script>

<script lang="ts">
	// Default import is required: chart.js/auto's default export is the Chart
	// class with all controllers registered; the named `Chart` re-export is the
	// bare class and renders nothing.
	import ChartJS from 'chart.js/auto';
	import { MatrixController, MatrixElement } from 'chartjs-chart-matrix';
	import { m } from '$lib/paraglide/messages.js';
	import { INK, seriesColor } from '$lib/palette';
	import Icon from './Icon.svelte';
	import { canCopyImage, chartToPng, copyImage, downloadBlob, pngFilename } from '$lib/image-export';

	ChartJS.register(MatrixController, MatrixElement);
	ChartJS.defaults.font.family = "'DM Sans Variable', ui-sans-serif, system-ui, sans-serif";

	let { spec: rawSpec }: { spec: ChartSpec } = $props();

	let canvas = $state<HTMLCanvasElement | null>(null);

	// --- export as image ---
	const copySupported = canCopyImage();
	let imageCopied = $state(false);

	async function toPng(): Promise<Blob | null> {
		return canvas ? await chartToPng(canvas, rawSpec.title, INK.surface) : null;
	}
	async function downloadPng() {
		const blob = await toPng();
		if (blob) downloadBlob(blob, pngFilename(rawSpec.title));
	}
	async function copyPng() {
		const blob = await toPng();
		if (blob && (await copyImage(blob))) {
			imageCopied = true;
			setTimeout(() => (imageCopied = false), 1500);
		}
	}

	const isCircular = $derived(
		rawSpec.type === 'pie' || rawSpec.type === 'doughnut' || rawSpec.type === 'polarArea'
	);

	/** 30% alpha fill derived from the series hue. */
	const alpha = (hex: string) => hex + '4d';

	/**
	 * Sequential scale for heatmaps: one hue, light → dark with magnitude
	 * (never a rainbow). Stops come from the palette's blue ramp.
	 */
	function heatColor(t: number): string {
		const stops: [number, number, number][] = [
			[0xcd, 0xe2, 0xfb], // blue-100
			[0x2a, 0x78, 0xd6], // blue-450
			[0x0d, 0x36, 0x6b] // blue-700
		];
		const clamped = Math.max(0, Math.min(1, t));
		const seg = clamped <= 0.5 ? 0 : 1;
		const local = (clamped - seg * 0.5) * 2;
		const mix = stops[seg].map((a, i) => Math.round(a + (stops[seg + 1][i] - a) * local));
		return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
	}

	// Streaming replaces message objects on every delta, so the `spec` prop
	// gets a NEW identity per token even though its content is frozen once the
	// tool returned. Depend on the serialized CONTENT instead — strings compare
	// by value, so the effect (and the expensive destroy/create of the chart)
	// only reruns when the chart actually changes.
	const specJson = $derived(JSON.stringify(rawSpec));

	$effect(() => {
		if (!canvas) return;

		// Parsing back also hands Chart.js a plain object: it mutates its config
		// internally, which on a Svelte reactive proxy would re-trigger this
		// effect in a destroy/create loop (blank canvas).
		const spec = JSON.parse(specJson) as ChartSpec;

		const horizontal = spec.type === 'horizontalBar';

		// Heatmap is a different beast (matrix plugin): each dataset is one row,
		// each label one column; cells are colored on a sequential scale.
		if (spec.type === 'heatmap') {
			const cols = spec.labels ?? [];
			const rows = spec.datasets.map((d) => d.label);
			const cells = spec.datasets.flatMap((ds) =>
				(ds.data as number[]).map((v, c) => ({ x: cols[c], y: ds.label, v }))
			);
			const values = cells.map((c) => c.v);
			const min = Math.min(...values);
			const span = Math.max(...values) - min || 1;

			const chart = new ChartJS(canvas, {
				type: 'matrix',
				data: {
					datasets: [
						{
							label: spec.title,
							data: cells as never[],
							backgroundColor: (ctx) =>
								heatColor((((ctx.raw as { v: number })?.v ?? min) - min) / span),
							borderColor: INK.surface,
							borderWidth: 1,
							width: (ctx) => (ctx.chart.chartArea?.width ?? 0) / cols.length - 2,
							height: (ctx) => (ctx.chart.chartArea?.height ?? 0) / rows.length - 2
						}
					]
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					plugins: {
						legend: { display: false },
						tooltip: {
							callbacks: {
								title: () => spec.title,
								label: (ctx) => {
									const raw = ctx.raw as { x: string; y: string; v: number };
									return `${raw.y} × ${raw.x}: ${raw.v}`;
								}
							}
						}
					},
					scales: {
						x: {
							type: 'category',
							labels: cols,
							offset: true,
							grid: { display: false },
							border: { display: false },
							ticks: { color: INK.muted }
						},
						y: {
							type: 'category',
							labels: rows,
							offset: true,
							grid: { display: false },
							border: { display: false },
							ticks: { color: INK.muted }
						}
					}
				}
			});
			return () => chart.destroy();
		}

		const chartType =
			spec.type === 'horizontalBar'
				? 'bar'
				: spec.type === 'area'
					? 'line'
					: spec.type;

		const datasets = spec.datasets.map((ds, i) => {
			const color = seriesColor(i);
			switch (spec.type) {
				case 'bubble':
					return {
						...ds,
						backgroundColor: alpha(color),
						borderColor: color,
						borderWidth: 1.5
					};
				case 'pie':
				case 'doughnut':
				case 'polarArea':
					// Circular charts color per-slice, in fixed categorical order.
					return {
						...ds,
						backgroundColor: (spec.labels ?? []).map((_, j) => seriesColor(j)),
						borderColor: INK.surface,
						borderWidth: 2 // 2px surface gap between adjacent fills
					};
				case 'line':
				case 'area':
					return {
						...ds,
						borderColor: color,
						backgroundColor: spec.type === 'area' ? alpha(color) : color,
						fill: spec.type === 'area',
						borderWidth: 2,
						pointRadius: (spec.labels?.length ?? 0) > 30 ? 0 : 3,
						pointHoverRadius: 5,
						tension: 0.25
					};
				case 'scatter':
					return {
						...ds,
						backgroundColor: color,
						borderColor: color,
						pointRadius: 4,
						pointHoverRadius: 6
					};
				case 'radar':
					return {
						...ds,
						borderColor: color,
						backgroundColor: alpha(color),
						borderWidth: 2,
						pointRadius: 3,
						pointBackgroundColor: color
					};
				default: {
					// bar / horizontalBar — rounded corners on the VALUE end,
					// anchored to the baseline.
					const radius = horizontal
						? { topRight: 4, bottomRight: 4 }
						: { topLeft: 4, topRight: 4 };
					return {
						...ds,
						backgroundColor: color,
						borderRadius: radius,
						borderSkipped: 'start' as const,
						maxBarThickness: 48,
						borderColor: INK.surface,
						borderWidth: spec.stacked ? 1 : 0 // surface gap between stacked segments
					};
				}
			}
		});

		const categoryAxis = {
			stacked: spec.stacked ?? false,
			grid: { display: false },
			border: { color: INK.baseline },
			ticks: { color: INK.muted }
		};
		const valueAxis = {
			stacked: spec.stacked ?? false,
			beginAtZero: true,
			grid: { color: INK.gridline },
			border: { display: false },
			ticks: { color: INK.muted }
		};
		const withTitle = (axis: object, label?: string) =>
			label ? { ...axis, title: { display: true, text: label, color: INK.secondary } } : axis;

		let scales: Record<string, object> | undefined;
		if (spec.type === 'pie' || spec.type === 'doughnut') {
			scales = undefined;
		} else if (spec.type === 'polarArea') {
			scales = {
				r: {
					beginAtZero: true,
					grid: { color: INK.gridline },
					ticks: { color: INK.muted, backdropColor: 'transparent' }
				}
			};
		} else if (spec.type === 'radar') {
			scales = {
				r: {
					beginAtZero: true,
					grid: { color: INK.gridline },
					angleLines: { color: INK.gridline },
					pointLabels: { color: INK.secondary },
					ticks: { color: INK.muted, backdropColor: 'transparent' }
				}
			};
		} else if (spec.type === 'scatter' || spec.type === 'bubble') {
			scales = {
				x: withTitle({ ...valueAxis, grid: { color: INK.gridline } }, spec.xLabel),
				y: withTitle(valueAxis, spec.yLabel)
			};
		} else if (horizontal) {
			scales = {
				x: withTitle(valueAxis, spec.xLabel),
				y: withTitle(categoryAxis, spec.yLabel)
			};
		} else {
			scales = {
				x: withTitle(categoryAxis, spec.xLabel),
				y: withTitle(valueAxis, spec.yLabel)
			};
		}

		const chart = new ChartJS(canvas, {
			type: chartType,
			data: { labels: spec.labels, datasets },
			options: {
				responsive: true,
				maintainAspectRatio: false,
				indexAxis: horizontal ? 'y' : 'x',
				plugins: {
					legend: {
						// A single series needs no legend — the title names it.
						display: isCircular || spec.datasets.length > 1,
						position: 'bottom',
						labels: { color: INK.secondary, boxWidth: 10, boxHeight: 10, usePointStyle: true }
					},
					tooltip: { enabled: true }
				},
				scales
			}
		});

		return () => chart.destroy();
	});
</script>

<figure
	class="rounded-xl border border-neutral-200 p-4"
	style:background-color={INK.surface}
	aria-label={rawSpec.title}
>
	<figcaption
		class="mb-3 flex items-center justify-between gap-2 text-sm font-semibold"
		style:color={INK.primary}
	>
		{rawSpec.title}
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
		</span>
	</figcaption>
	<div class="relative h-72">
		<canvas bind:this={canvas}></canvas>
	</div>
</figure>

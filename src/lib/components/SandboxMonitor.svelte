<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import Avatar from './Avatar.svelte';
	import Icon from './Icon.svelte';
	import HelpTip from './HelpTip.svelte';
	import { fetchSandboxes, sandboxAction, type SandboxRow } from '$lib/admin';

	/**
	 * Live view of the code-execution microVMs: KPI tiles, then one row per
	 * VM with CPU and memory meters. The console's only polling view — the
	 * snapshot is refreshed every few seconds while this section is mounted
	 * and the tab is visible, and stops otherwise.
	 */
	const POLL_MS = 3000;

	let rows = $state<SandboxRow[]>([]);
	let enabled = $state(true);
	let backend = $state<string | null>(null);
	let error = $state<string | null>(null);
	let loaded = $state(false);
	let lastAt = $state(0);
	let now = $state(Date.now());
	let busy = $state<string | null>(null);
	let inFlight = false;

	async function refresh() {
		if (inFlight) return;
		inFlight = true;
		const result = await fetchSandboxes();
		if (result.ok) {
			rows = result.sandboxes;
			enabled = result.enabled;
			backend = result.backend;
			error = null;
			lastAt = Date.now();
		} else {
			error = result.error;
		}
		loaded = true;
		inFlight = false;
	}

	$effect(() => {
		void refresh();
		let timer: ReturnType<typeof setInterval> | null = null;
		const start = () => {
			if (timer) return;
			timer = setInterval(() => {
				now = Date.now();
				if (document.visibilityState === 'visible') void refresh();
			}, POLL_MS);
		};
		const stop = () => {
			if (timer) clearInterval(timer);
			timer = null;
		};
		const onVisibility = () => (document.visibilityState === 'visible' ? (start(), refresh()) : stop());
		document.addEventListener('visibilitychange', onVisibility);
		start();
		return () => {
			stop();
			document.removeEventListener('visibilitychange', onVisibility);
		};
	});

	async function act(action: 'stop' | 'remove', row: SandboxRow) {
		if (busy) return;
		if (action === 'remove' && !confirm(m.sbx_remove_confirm({ name: row.name }))) return;
		busy = row.name;
		error = await sandboxAction(action, row.name);
		busy = null;
		await refresh();
	}

	// --- derived summary -----------------------------------------------------
	const running = $derived(rows.filter((r) => r.status === 'running'));
	const stopped = $derived(rows.filter((r) => r.status !== 'running'));
	const cpusAllocated = $derived(running.reduce((s, r) => s + r.cpus, 0));
	const memUsed = $derived(running.reduce((s, r) => s + (r.metrics?.memoryBytes ?? 0), 0));
	const memLimit = $derived(running.reduce((s, r) => s + r.memoryMib * 1024 * 1024, 0));
	const memPct = $derived(memLimit > 0 ? Math.round((memUsed / memLimit) * 100) : 0);
	const image = $derived(rows[0]?.image ?? '');
	const agoSec = $derived(lastAt ? Math.max(0, Math.round((now - lastAt) / 1000)) : 0);

	// --- formatting -------------------------------------------------------------
	const num1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
	function bytes(n: number): string {
		if (n < 1024) return `${Math.round(n)} B`;
		const units = ['KB', 'MB', 'GB', 'TB'];
		let v = n / 1024;
		let i = 0;
		while (v >= 1024 && i < units.length - 1) {
			v /= 1024;
			i++;
		}
		return `${num1.format(v)} ${units[i]}`;
	}
	function duration(ms: number): string {
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s} s`;
		const min = Math.floor(s / 60);
		if (min < 60) return `${min} min`;
		const h = Math.floor(min / 60);
		if (h < 48) return `${h} h ${min % 60} min`;
		return `${Math.floor(h / 24)} d`;
	}
	function since(ts: number | null): string {
		return ts ? duration(now - ts) : '';
	}
	function shortName(name: string): string {
		return name.replace(/^pai-c-/, '').replace(/^pai-/, '').slice(0, 8);
	}
	/** Meter color by load, like a system monitor: calm, warm, hot. */
	function meterClass(pct: number): string {
		return pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-300' : 'bg-success';
	}
	function statusLabel(s: SandboxRow['status']): string {
		return s === 'running'
			? m.sbx_running()
			: s === 'stopped'
				? m.sbx_stopped()
				: s === 'crashed'
					? m.sbx_crashed()
					: m.sbx_draining();
	}
	function statusDot(s: SandboxRow['status']): string {
		return s === 'running'
			? 'bg-success'
			: s === 'crashed'
				? 'bg-red-500'
				: s === 'draining'
					? 'bg-amber-300'
					: 'bg-neutral-300';
	}
</script>

{#snippet meter(pct: number, width: string)}
	<div class="h-1.5 {width} overflow-hidden rounded-full bg-fill">
		<div class="h-full rounded-full transition-[width] duration-500 {meterClass(pct)}" style="width:{Math.min(100, Math.max(0, pct))}%"></div>
	</div>
{/snippet}

{#if !loaded}
	<div class="flex justify-center py-16">
		<div class="size-6 animate-spin rounded-full border-2 border-edge border-t-accent"></div>
	</div>
{:else if !enabled}
	<p class="rounded-lg border border-dashed border-edge px-3 py-2.5 text-[13px] text-neutral-400">
		{m.sbx_disabled()}
	</p>
{:else}
	<!-- KPI tiles — the same shape as the usage statistics -->
	<div class="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
		<div class="rounded-xl border border-edge bg-surface px-4 py-3">
			<div class="text-[13px] text-neutral-400">{m.sbx_kpi_running()}</div>
			<div class="font-serif text-3xl font-semibold text-neutral-900 tabular-nums">{running.length}</div>
			<div class="mt-1 text-[11px] text-neutral-400">{m.sbx_kpi_stopped_sub({ n: stopped.length })}</div>
		</div>
		<div class="rounded-xl border border-edge bg-surface px-4 py-3">
			<div class="text-[13px] text-neutral-400">{m.sbx_kpi_cpus()}</div>
			<div class="font-serif text-3xl font-semibold text-neutral-900 tabular-nums">{cpusAllocated}</div>
			<div class="mt-1 text-[11px] text-neutral-400">{m.sbx_kpi_cpus_sub({ n: rows.length })}</div>
		</div>
		<div class="rounded-xl border border-edge bg-surface px-4 py-3">
			<div class="text-[13px] text-neutral-400">{m.sbx_kpi_memory()}</div>
			<div class="font-serif text-3xl font-semibold text-neutral-900 tabular-nums">{bytes(memUsed)}</div>
			<div class="mt-2">{@render meter(memPct, 'w-full')}</div>
			<div class="mt-1 text-[11px] text-neutral-400">{m.sbx_kpi_memory_sub({ limit: bytes(memLimit) })}</div>
		</div>
		<div class="rounded-xl border border-edge bg-surface px-4 py-3">
			<div class="text-[13px] text-neutral-400">{m.sbx_kpi_backend()}</div>
			<div class="font-serif text-3xl font-semibold text-neutral-900">
				{backend === 'cloud' ? m.sbx_backend_cloud() : m.sbx_backend_local()}
			</div>
			<div class="mt-1 truncate text-[11px] text-neutral-400" title={image}>
				{image ? m.sbx_image({ image }) : ''}
			</div>
		</div>
	</div>

	<div class="rounded-xl border border-edge bg-surface">
		<div class="flex flex-wrap items-center gap-2 px-4 py-3">
			<span class="flex items-center gap-1.5 text-[13px] text-neutral-500">
				<span class="size-1.5 rounded-full {agoSec < 10 ? 'bg-success' : 'bg-neutral-300'}"></span>
				{m.sbx_updated({ s: agoSec })}
			</span>
			<span class="flex-1"></span>
			<button
				onclick={() => refresh()}
				class="flex shrink-0 items-center gap-1.5 rounded-lg border border-edge bg-surface px-2.5 py-1 text-xs font-medium text-neutral-600 transition hover:border-accent/40 hover:bg-canvas hover:text-accent-strong"
			>
				<Icon name="refresh" size={12} />
				{m.sbx_refresh()}
			</button>
			<HelpTip text={m.sbx_help()} align="right" />
		</div>
		{#if error}
			<p class="border-t border-red-100 bg-red-50 px-4 py-2 text-[13px] text-red-700">{error}</p>
		{/if}

		{#if rows.length === 0}
			<p class="border-t border-edge-soft px-4 py-6 text-center text-[13px] text-neutral-400">{m.sbx_empty()}</p>
		{:else}
			<div class="overflow-x-auto rounded-b-xl">
				<table class="w-full text-left">
					<thead>
						<tr class="border-y border-edge-soft bg-canvas/60 text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">
							<th class="py-2 pl-4 font-semibold">{m.sbx_col_name()}</th>
							<th class="px-3 py-2 font-semibold">{m.sbx_col_user()}</th>
							<th class="px-3 py-2 font-semibold">{m.sbx_col_conversation()}</th>
							<th class="px-3 py-2 font-semibold">{m.sbx_col_status()}</th>
							<th class="px-3 py-2 font-semibold">{m.sbx_col_cpu()}</th>
							<th class="px-3 py-2 font-semibold">{m.sbx_col_memory()}</th>
							<th class="px-3 py-2 font-semibold">{m.sbx_col_net()}</th>
							<th class="px-3 py-2 font-semibold">{m.sbx_col_uptime()}</th>
							<th class="py-2 pr-4"></th>
						</tr>
					</thead>
					<tbody>
						{#each rows as r (r.name)}
							{@const live = r.status === 'running'}
							{@const cpu = r.metrics ? Math.round(r.metrics.cpuPercent) : 0}
							{@const memPctRow = r.metrics && r.metrics.memoryLimitBytes > 0 ? Math.round((r.metrics.memoryBytes / r.metrics.memoryLimitBytes) * 100) : 0}
							<tr class="border-b border-edge-soft last:border-b-0 {live ? '' : 'text-neutral-400'}">
								<td class="py-2.5 pl-4">
									<div class="flex items-center gap-2">
										<span class="text-[13px] font-medium {live ? 'text-neutral-800' : ''}" title={r.name}>{shortName(r.name)}</span>
										<span class="rounded bg-fill px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
											{r.kind === 'conversation' ? m.sbx_kind_conversation() : m.sbx_kind_ephemeral()}
										</span>
									</div>
									<div class="mt-0.5 text-[11px] text-neutral-400 tabular-nums">{r.cpus} vCPU · {r.memoryMib} MB</div>
								</td>
								<td class="px-3 py-2.5">
									{#if r.user}
										<div class="flex items-center gap-2">
											<Avatar username={r.user} size={22} />
											<span class="max-w-36 truncate text-[13px] font-medium {live ? 'text-neutral-800' : ''}">{r.user}</span>
										</div>
									{:else}
										<span class="text-sm text-neutral-300">—</span>
									{/if}
								</td>
								<td class="max-w-56 px-3 py-2.5">
									{#if r.conversationTitle}
										<span class="block truncate text-[13px]" title={r.conversationTitle}>{r.conversationTitle}</span>
									{:else if r.kind === 'ephemeral'}
										<span class="text-[13px] text-neutral-400">{m.sbx_conversation_ephemeral()}</span>
									{:else}
										<span class="text-sm text-neutral-300">—</span>
									{/if}
								</td>
								<td class="px-3 py-2.5 whitespace-nowrap">
									<span class="inline-flex items-center gap-1.5 text-[13px]">
										<span class="size-1.5 shrink-0 rounded-full {statusDot(r.status)}"></span>
										{statusLabel(r.status)}
									</span>
								</td>
								<td class="px-3 py-2.5">
									{#if r.metrics}
										<div class="flex items-center gap-2">
											{@render meter(cpu, 'w-20')}
											<span class="w-9 text-right text-[13px] tabular-nums">{cpu}%</span>
										</div>
									{:else}
										<span class="text-sm text-neutral-300" title={live ? m.sbx_no_metrics() : ''}>—</span>
									{/if}
								</td>
								<td class="px-3 py-2.5">
									{#if r.metrics}
										<div class="flex items-center gap-2">
											{@render meter(memPctRow, 'w-20')}
											<span class="text-[13px] whitespace-nowrap tabular-nums">
												{bytes(r.metrics.memoryBytes)}
												<span class="text-neutral-400">/ {bytes(r.metrics.memoryLimitBytes)}</span>
											</span>
										</div>
									{:else}
										<span class="text-sm text-neutral-300">—</span>
									{/if}
								</td>
								<td class="px-3 py-2.5 text-[13px] whitespace-nowrap tabular-nums">
									{#if r.metrics}
										<span title={m.sbx_net_rx()}>↓ {bytes(r.metrics.netRxBytes)}</span>
										<span class="ml-2" title={m.sbx_net_tx()}>↑ {bytes(r.metrics.netTxBytes)}</span>
									{:else}
										<span class="text-sm text-neutral-300">—</span>
									{/if}
								</td>
								<td class="px-3 py-2.5 text-[13px] whitespace-nowrap tabular-nums">
									{#if r.metrics}
										{duration(r.metrics.uptimeMs)}
									{:else if r.updatedAt}
										<span class="text-neutral-400">{m.sbx_stopped_since({ t: since(r.updatedAt) })}</span>
									{:else}
										<span class="text-sm text-neutral-300">—</span>
									{/if}
								</td>
								<td class="py-2.5 pr-4 text-right">
									<div class="flex items-center justify-end gap-1">
										{#if live}
											<button
												onclick={() => act('stop', r)}
												disabled={busy !== null}
												class="rounded p-1 text-neutral-400 transition hover:bg-fill hover:text-neutral-800 disabled:opacity-30"
												title={m.sbx_stop()}
												aria-label={m.sbx_stop()}
											>
												<Icon name="stop" size={14} />
											</button>
										{/if}
										<button
											onclick={() => act('remove', r)}
											disabled={busy !== null}
											class="rounded p-1 text-neutral-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
											title={m.sbx_remove()}
											aria-label={m.sbx_remove()}
										>
											<Icon name="trash" size={14} />
										</button>
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
{/if}

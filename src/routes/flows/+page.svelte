<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import Icon from '$lib/components/Icon.svelte';
	import Mermaid from '$lib/components/Mermaid.svelte';
	import SelectMenu from '$lib/components/SelectMenu.svelte';
	import FlowBuilderChat from '$lib/components/FlowBuilderChat.svelte';
	import { getToken, hasSession } from '$lib/session';
	import { fetchSettings } from '$lib/settings';
	import { clickOutside } from '$lib/actions/clickOutside';
	import {
		listFlows,
		getFlow,
		activateFlow,
		deactivateFlow,
		runFlow,
		deleteFlow,
		listRuns,
		listTraces,
		loadFlowChat,
		listFlowDepartments,
		assignFlowDepartment,
		type FlowRecordWithAccess,
		type FlowDepartmentOption
	} from '$lib/flows';
	import { flowSpecToMermaid } from '$lib/flow-mermaid';
	import type { FlowListItem, FlowRun, FlowTrace } from '$lib/flow-spec';
	import type { UIMessage } from 'ai';
	import { MODEL_STORAGE_KEY, modelLabel, type ModelOption } from '$lib/models';

	// Redirect to login without a session; bounce non-builders to chat. The
	// /api/flows routes enforce builder/admin per request too.
	$effect(() => {
		if (browser && !hasSession()) goto('/login');
	});
	let isAdmin = $state(false);
	$effect(() => {
		if (!browser || !hasSession()) return;
		fetchSettings().then((s) => {
			if (s && s.role !== 'admin' && s.role !== 'builder') goto('/');
			else if (s) isAdmin = s.role === 'admin';
		});
	});

	let flows = $state<FlowListItem[]>([]);
	let departments = $state<FlowDepartmentOption[]>([]);
	/** Target department for a NEW flow (from the picker). */
	let newDeptId = $state<string | null>(null);
	let loaded = $state(false);
	let selected = $state<FlowRecordWithAccess | null>(null);
	let selectedVersion = $state<number | null>(null);
	let runs = $state<FlowRun[]>([]);
	let traces = $state<FlowTrace[]>([]);
	let expandedRunId = $state<string | null>(null);
	let openNodeId = $state<string | null>(null);
	let busyAction = $state<string | null>(null);
	let actionError = $state<string | null>(null);
	let flowMenuOpen = $state(false);

	// The builder chat: keyed so switching flows remounts it with that flow's
	// saved transcript, but a freshly-created flow re-binds WITHOUT remounting
	// (chatFlowId changes, chatKey stays) so the composing conversation survives.
	let chatKey = $state('new-0');
	let chatFlowId = $state<string | null>(null);
	let chatInitial = $state<UIMessage[]>([]);
	let newCounter = 0;

	// Empty pick is fine — the server resolves '' (or any unknown id) to its
	// default model. The catalog fetch below is only for showing labels.
	const model = (browser && localStorage.getItem(MODEL_STORAGE_KEY)) || '';

	let knownModels = $state<ModelOption[]>([]);
	let defaultModelId = $state('');
	$effect(() => {
		if (!browser || !hasSession()) return;
		fetch('/api/models', { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
			.then((res) => (res.ok ? res.json() : null))
			.then((data) => {
				if (!data) return;
				knownModels = data.all ?? data.models ?? [];
				defaultModelId = data.default ?? '';
			})
			.catch(() => {});
	});

	$effect(() => {
		if (!browser || !hasSession()) return;
		listFlowDepartments().then((d) => {
			departments = d;
			if (!newDeptId) newDeptId = d[0]?.id ?? null;
		});
		listFlows().then((list) => {
			flows = list;
			loaded = true;
			const wanted = page.url.searchParams.get('id');
			if (wanted && !selected) select(wanted, false);
		});
	});

	async function select(id: string, pushUrl = true) {
		const record = await getFlow(id);
		if (!record) return;
		selected = record;
		selectedVersion = record.versions.at(-1)?.version ?? null;
		actionError = null;
		expandedRunId = null;
		openNodeId = null;
		flowMenuOpen = false;
		chatInitial = await loadFlowChat(id);
		chatFlowId = id;
		chatKey = id;
		if (pushUrl) replaceState(`/flows?id=${encodeURIComponent(id)}`, {});
		if (record.deployment) [runs, traces] = await Promise.all([listRuns(id), listTraces(id)]);
		else {
			runs = [];
			traces = [];
		}
	}

	function newFlow() {
		selected = null;
		selectedVersion = null;
		runs = [];
		traces = [];
		openNodeId = null;
		actionError = null;
		flowMenuOpen = false;
		chatInitial = [];
		chatFlowId = null;
		newDeptId = departments[0]?.id ?? null;
		chatKey = `new-${++newCounter}`;
		replaceState('/flows', {});
	}

	// Fired by the builder chat each time upsertFlow succeeds — refresh the
	// diagram/version. A new flow binds here without remounting the chat.
	async function onFlowSaved(id: string, version: number) {
		flows = await listFlows();
		const record = await getFlow(id);
		if (!record) return;
		selected = record;
		selectedVersion = version || (record.versions.at(-1)?.version ?? null);
		chatFlowId = id;
		if (record.deployment) [runs, traces] = await Promise.all([listRuns(id), listTraces(id)]);
	}

	async function refreshList() {
		flows = await listFlows();
	}

	const version = $derived(
		selected?.versions.find((v) => v.version === selectedVersion) ?? selected?.versions.at(-1) ?? null
	);
	const mermaid = $derived(version ? flowSpecToMermaid(version.spec) : '');

	// Activation is owner-only (it seals the activator's live creds as run-as).
	const canActivate = $derived(
		selected !== null &&
			selected.access === 'owner' &&
			version !== null &&
			selected.deployment?.deployedVersion !== version.version
	);
	// Edit/delete/deactivate/reassign — owner or admin.
	const canEdit = $derived(
		selected !== null && (selected.access === 'owner' || selected.access === 'admin')
	);
	// Read-only builder chat: a selected flow the user may only view/run, OR a new
	// flow with no department to assign it to (nothing to create it under).
	const chatReadOnly = $derived(
		(selected !== null && !canEdit) || (chatFlowId === null && newDeptId === null)
	);

	// Option lists for the styled SelectMenu dropdowns.
	const deptOptions = $derived(departments.map((d) => ({ value: d.id, label: d.name })));
	const NONE = '__none__'; // sentinel for "no department" (orphan)
	const reassignOptions = $derived([
		...departments.map((d) => ({ value: d.id, label: d.name })),
		...(isAdmin || selected?.departmentId === null
			? [{ value: NONE, label: m.flow_department_none() }]
			: [])
	]);
	const versionOptions = $derived(
		selected
			? [...selected.versions]
					.reverse()
					.map((v) => ({ value: String(v.version), label: m.flow_version({ version: v.version }) }))
			: []
	);

	// Group the flow list by department, with orphaned flows collected apart.
	const flowGroups = $derived.by(() => {
		const groups = new Map<string, FlowListItem[]>();
		const orphaned: FlowListItem[] = [];
		for (const f of flows) {
			if (f.orphaned) orphaned.push(f);
			else {
				const key = f.departmentName ?? '—';
				const list = groups.get(key) ?? [];
				list.push(f);
				groups.set(key, list);
			}
		}
		return { groups: [...groups.entries()], orphaned };
	});
	// Department stamped on a NEW flow; irrelevant once a flow is bound.
	const chatDeptId = $derived(chatFlowId ? null : newDeptId);

	async function doAssignDept(departmentId: string | null) {
		if (!selected) return;
		const updated = await assignFlowDepartment(selected.id, departmentId);
		if (updated) {
			selected = updated;
			await refreshList();
		}
	}

	function friendly(error: string): string {
		return error === 'needs_deploy_token' ? m.flow_needs_deploy_token() : error;
	}

	async function doActivate() {
		if (!selected || !version) return;
		const access = selected.access;
		busyAction = 'activate';
		actionError = null;
		const result = await activateFlow(selected.id, version.version);
		if (result.ok) {
			selected = { ...result.record, access };
			runs = await listRuns(result.record.id);
			await refreshList();
		} else actionError = friendly(result.error);
		busyAction = null;
	}
	async function doDeactivate() {
		if (!selected) return;
		const access = selected.access;
		busyAction = 'deactivate';
		actionError = null;
		const result = await deactivateFlow(selected.id);
		if (result.ok) {
			selected = { ...result.record, access };
			runs = [];
			await refreshList();
		} else actionError = friendly(result.error);
		busyAction = null;
	}
	async function doRun() {
		if (!selected) return;
		busyAction = 'run';
		actionError = null;
		const result = await runFlow(selected.id);
		if (result.error) actionError = friendly(result.error);
		setTimeout(async () => {
			if (selected) runs = await listRuns(selected.id);
		}, 1200);
		busyAction = null;
	}
	async function doDelete() {
		if (!selected || !confirm(m.flow_delete_confirm())) return;
		busyAction = 'delete';
		const id = selected.id;
		if (await deleteFlow(id)) {
			await refreshList();
			if (flows[0]) await select(flows[0].id, true);
			else newFlow();
		}
		busyAction = null;
	}

	async function refreshRuns() {
		if (selected?.deployment)
			[runs, traces] = await Promise.all([listRuns(selected.id), listTraces(selected.id)]);
	}
	const traceFor = (runId: string) => traces.find((t) => t.jobId === runId) ?? null;

	$effect(() => {
		const id = expandedRunId;
		if (!id) return;
		const run = runs.find((r) => r.id === id);
		if (!run || (run.state !== 'running' && run.state !== 'queued')) return;
		const timer = setInterval(refreshRuns, 3000);
		return () => clearInterval(timer);
	});

	const fmtDate = (iso: string) =>
		new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
	const fmtUpdated = (ms: number) =>
		new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
	const fmtRunTime = (iso: string | null) =>
		iso
			? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
			: '—';

	const nodeIcon = (kind: string) =>
		kind === 'trigger' ? 'clock' : kind === 'agent' ? 'sparkle' : kind === 'notify' ? 'mail' : 'activity';
	const nodeKindLabel = (kind: string) =>
		kind === 'trigger'
			? m.flow_node_trigger()
			: kind === 'sqlCheck'
				? m.flow_node_sqlcheck()
				: kind === 'agent'
					? m.flow_node_agent()
					: m.flow_node_notify();

	const actionBtn =
		'flex shrink-0 items-center gap-1.5 rounded-lg border border-[#e3e0d5] bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-[#faf9f5] disabled:opacity-50';
</script>

<svelte:head><title>{m.flows_title()} — PerguntAI</title></svelte:head>

<div class="flex h-dvh bg-[#faf9f5] text-neutral-800">
	<!-- LEFT: builder chat -->
	<aside class="flex w-[38%] min-w-[340px] max-w-[520px] shrink-0 flex-col border-r border-[#e3e0d5] bg-[#f7f6f1]">
		<header class="flex items-center gap-2 border-b border-[#e3e0d5] bg-[#f7f6f1] px-3 py-3">
			<button
				onclick={() => goto('/')}
				class="grid size-8 shrink-0 place-items-center rounded-lg text-neutral-500 transition hover:bg-[#d97757]/10 hover:text-[#bd5d3a]"
				title={m.back_to_chat()}
				aria-label={m.back_to_chat()}
			>
				<Icon name="arrow-right" size={15} class="rotate-180" />
			</button>

			<!-- flow switcher -->
			<div class="relative min-w-0 flex-1" use:clickOutside={{ onOutside: () => (flowMenuOpen = false) }}>
				<button
					onclick={() => (flowMenuOpen = !flowMenuOpen)}
					class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-[#eceae1]"
				>
					<span class="grid size-6 shrink-0 place-items-center rounded-md bg-[#d97757]/12 text-[#bd5d3a]">
						<Icon name="zap" size={13} />
					</span>
					<span class="min-w-0 flex-1 truncate text-sm font-semibold">
						{selected ? selected.name : m.flow_builder_new_title()}
					</span>
					<Icon name="chevron-down" size={14} class="shrink-0 text-neutral-400 {flowMenuOpen ? 'rotate-180' : ''}" />
				</button>

				{#if flowMenuOpen}
					<div class="absolute top-full left-0 z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded-xl border border-[#e3e0d5] bg-white p-1.5 shadow-lg">
						<button
							onclick={newFlow}
							class="mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-[#bd5d3a] transition hover:bg-[#d97757]/8"
						>
							<Icon name="plus" size={15} />
							{m.flow_builder_new()}
						</button>
						{#snippet row(flow: FlowListItem)}
							<button
								onclick={() => select(flow.id)}
								class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition
									{selected?.id === flow.id ? 'bg-[#d97757]/10' : 'hover:bg-[#f5f4ee]'}"
							>
								<span class="min-w-0 flex-1">
									<span class="block truncate text-sm">{flow.name}</span>
									{#if flow.access !== 'owner'}
										<span class="block truncate text-[10px] text-neutral-400">{flow.owner}</span>
									{/if}
								</span>
								{#if flow.activeVersion !== null}
									<span class="shrink-0 rounded bg-[#1baf7a]/12 px-1.5 text-[10px] font-semibold text-[#0d8a5f]">v{flow.activeVersion}</span>
								{:else}
									<span class="shrink-0 rounded bg-[#e3e0d5] px-1.5 text-[10px] font-semibold text-neutral-500">{fmtUpdated(flow.updatedAt)}</span>
								{/if}
							</button>
						{/snippet}

						{#each flowGroups.groups as [deptName, list] (deptName)}
							<p class="mt-1.5 px-2.5 pt-1 pb-0.5 text-[10px] font-semibold tracking-wide text-neutral-400 uppercase">{deptName}</p>
							{#each list as flow (flow.id)}{@render row(flow)}{/each}
						{/each}
						{#if flowGroups.orphaned.length}
							<p class="mt-1.5 flex items-center gap-1 px-2.5 pt-1 pb-0.5 text-[10px] font-semibold tracking-wide text-amber-600 uppercase">
								<Icon name="key" size={10} />{m.flow_orphaned_group()}
							</p>
							{#each flowGroups.orphaned as flow (flow.id)}{@render row(flow)}{/each}
						{/if}
						{#if flows.length === 0}
							<p class="px-2.5 py-3 text-center text-xs text-neutral-400">{m.flows_empty()}</p>
						{/if}
					</div>
				{/if}
			</div>
		</header>

		<!-- new-flow department picker -->
		{#if chatFlowId === null}
			<div class="flex items-center gap-2 border-b border-[#e3e0d5] px-3 py-2 text-xs">
				{#if departments.length}
					<span class="shrink-0 text-neutral-500">{m.flow_dept_for_new()}</span>
					<SelectMenu
						options={deptOptions}
						value={newDeptId ?? ''}
						onSelect={(v) => (newDeptId = v)}
						triggerClass="min-w-0 flex-1"
					/>
				{:else}
					<span class="text-amber-700">{m.flow_dept_none_warning()}</span>
				{/if}
			</div>
		{/if}

		{#key chatKey}
			<FlowBuilderChat
				flowId={chatFlowId}
				departmentId={chatDeptId}
				initialMessages={chatInitial}
				{model}
				readOnly={chatReadOnly}
				{onFlowSaved}
			/>
		{/key}
	</aside>

	<!-- RIGHT: diagram + actions + runs -->
	<main class="flex min-w-0 flex-1 flex-col">
		{#if selected && version}
			<header class="flex items-center gap-2 border-b border-[#e3e0d5] bg-white px-5 py-3">
				<div class="min-w-0 flex-1">
					<h2 class="truncate text-sm font-semibold">{selected.name}</h2>
					<p class="truncate text-[11px] text-neutral-500">
						{m.flow_provenance({ version: version.version, date: fmtDate(version.createdAt) })}
					</p>
				</div>
				{#if selected.versions.length > 1}
					<SelectMenu
						options={versionOptions}
						value={String(selectedVersion)}
						onSelect={(v) => (selectedVersion = Number(v))}
					/>
				{/if}
				{#if selected.deployment}
					<span class="shrink-0 rounded-full border border-[#1baf7a]/30 bg-[#1baf7a]/10 px-2.5 py-0.5 text-[11px] font-medium text-[#0d8a5f]">
						{m.flow_status_active({ version: selected.deployment.deployedVersion })}
					</span>
				{:else}
					<span class="shrink-0 rounded-full border border-[#e3e0d5] bg-[#faf9f5] px-2.5 py-0.5 text-[11px] font-medium text-neutral-600">
						{m.flow_status_draft()}
					</span>
				{/if}
				{#if canActivate}
					<button onclick={doActivate} disabled={busyAction !== null} class="flex shrink-0 items-center gap-1.5 rounded-lg bg-[#d97757] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[#bd5d3a] disabled:opacity-50">
						<Icon name="play" size={12} />
						{busyAction === 'activate' ? m.flow_activating() : m.flow_activate({ version: version.version })}
					</button>
				{/if}
				{#if selected.deployment}
					<button onclick={doRun} disabled={busyAction !== null} class={actionBtn}>
						<Icon name="zap" size={12} />{m.flow_run_now()}
					</button>
					{#if canEdit}
						<button onclick={doDeactivate} disabled={busyAction !== null} class={actionBtn}>
							<Icon name="pause" size={12} />{m.flow_deactivate()}
						</button>
					{/if}
				{/if}
				{#if canEdit}
					<button
						onclick={doDelete}
						disabled={busyAction !== null}
						class="grid size-8 shrink-0 place-items-center rounded-lg text-neutral-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
						title={m.flow_delete()}
						aria-label={m.flow_delete()}
					>
						<Icon name="trash" size={14} />
					</button>
				{/if}
			</header>
			<!-- department bar: reassign (owner/admin) or a read-only label -->
			<div class="flex items-center gap-2 border-b border-[#e3e0d5] bg-[#faf9f5] px-5 py-1.5 text-[11px]">
				<Icon name="building" size={12} class="shrink-0 text-neutral-400" />
				{#if canEdit && departments.length}
					<span class="shrink-0 text-neutral-500">{m.flow_department()}</span>
					<SelectMenu
						options={reassignOptions}
						value={selected.departmentId ?? NONE}
						onSelect={(v) => doAssignDept(v === NONE ? null : v)}
					/>
				{:else}
					<span class="text-neutral-500">
						{selected.departmentId === null ? m.flow_orphaned_group() : m.flow_department()}
					</span>
				{/if}
				<span class="ml-auto shrink-0 text-neutral-400">{selected.owner}</span>
			</div>
			{#if actionError}
				<div class="border-b border-red-200 bg-red-50 px-5 py-2 text-xs text-red-700" role="alert">{actionError}</div>
			{/if}

			<div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
				<!-- diagram -->
				{#key mermaid}
					<Mermaid code={mermaid} title={selected.name} />
				{/key}

				<!-- node details -->
				<div class="mt-5 space-y-1.5">
					<h3 class="mb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase">{m.flow_steps_title()}</h3>
					{#each version.spec.nodes as node (node.id)}
						<div class="rounded-xl border border-[#e3e0d5] bg-white">
							<button
								onclick={() => (openNodeId = openNodeId === node.id ? null : node.id)}
								class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
							>
								<span class="grid size-7 shrink-0 place-items-center rounded-lg bg-[#f0eee6] text-neutral-600">
									<Icon name={nodeIcon(node.kind)} size={14} />
								</span>
								<span class="min-w-0 flex-1">
									<span class="block truncate text-sm font-medium">{node.label ?? nodeKindLabel(node.kind)}</span>
									<span class="block text-[11px] text-neutral-400">{nodeKindLabel(node.kind)}</span>
								</span>
								<Icon name="chevron-down" size={14} class="shrink-0 text-neutral-400 {openNodeId === node.id ? 'rotate-180' : ''}" />
							</button>
							{#if openNodeId === node.id}
								<div class="space-y-2.5 border-t border-[#efede3] px-3 py-3 text-sm">
									{#if node.kind === 'trigger'}
										<div><p class="detail-label">{m.flow_cron()}</p><p class="font-mono text-[13px]">{node.config.mode === 'schedule' ? node.config.cron : m.flow_trigger_manual()}</p></div>
									{:else if node.kind === 'sqlCheck'}
										<div><p class="detail-label">{m.flow_condition()}</p><p class="font-mono text-[13px]">valor {node.config.op} {node.config.threshold}</p></div>
										<div><p class="detail-label">{m.flow_query()}</p><pre class="detail-pre">{node.config.query}</pre></div>
									{:else if node.kind === 'agent'}
										<div><p class="detail-label">{m.flow_model()}</p><p>{modelLabel(knownModels, node.config.model ?? defaultModelId)}</p></div>
										<div><p class="detail-label">{m.flow_tools()}</p><p>{node.config.tools.length > 0 ? node.config.tools.join(' · ') : '—'}</p></div>
										<div><p class="detail-label">{m.flow_prompt()}</p><pre class="detail-pre">{node.config.prompt}</pre></div>
									{:else}
										<div><p class="detail-label">{m.flow_script()}</p><p class="font-mono text-[12px] break-all">{node.config.scriptPath}</p></div>
										<div><p class="detail-label">{m.flow_recipients()}</p><p>{node.config.recipients.join(', ')}</p></div>
										{#if node.config.subject}<div><p class="detail-label">{m.flow_subject()}</p><p>{node.config.subject}</p></div>{/if}
									{/if}
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>

			{#if selected.deployment}
				<section class="{expandedRunId ? 'max-h-80' : 'max-h-44'} shrink-0 overflow-y-auto border-t border-[#e3e0d5] bg-white px-5 py-3">
					<div class="mb-2 flex items-center gap-2">
						<h3 class="text-xs font-semibold tracking-wide text-neutral-500 uppercase">{m.flow_runs()}</h3>
						<button onclick={refreshRuns} class="grid size-6 place-items-center rounded-md text-neutral-400 transition hover:bg-[#f0eee6] hover:text-neutral-700" title={m.flow_runs()} aria-label={m.flow_runs()}>
							<Icon name="refresh" size={12} />
						</button>
					</div>
					{#if runs.length === 0}
						<p class="text-xs text-neutral-400">{m.flow_runs_empty()}</p>
					{:else}
						<ul class="flex flex-col gap-1">
							{#each runs as run (run.id)}
								{@const trace = traceFor(run.id)}
								<li class="flex flex-col">
									<button onclick={() => (expandedRunId = expandedRunId === run.id ? null : run.id)} class="flex items-center gap-2.5 rounded-lg px-1 py-0.5 text-left text-xs text-neutral-600 transition hover:bg-[#faf9f5]">
										<span class="size-2 shrink-0 rounded-full {run.state === 'running' || run.state === 'queued' ? 'animate-pulse bg-amber-400' : run.state === 'scheduled' ? 'bg-neutral-300' : run.state === 'success' ? 'bg-[#1baf7a]' : 'bg-red-500'}"></span>
										<span class="w-40 shrink-0 font-medium">
											{run.state === 'running' ? m.flow_run_running() : run.state === 'queued' ? m.flow_run_queued() : run.state === 'scheduled' ? m.flow_run_scheduled({ time: fmtRunTime(run.scheduledFor) }) : run.state === 'success' ? m.flow_run_success() : m.flow_run_failed()}
										</span>
										{#if run.state !== 'scheduled'}<span class="shrink-0">{fmtRunTime(run.startedAt)}</span>{/if}
										{#if run.durationMs !== null}<span class="text-neutral-400">{(run.durationMs / 1000).toFixed(1)}s</span>{/if}
										{#if trace}<Icon name="chevron-down" size={12} class="text-neutral-400 transition-transform {expandedRunId === run.id ? 'rotate-180' : ''}" />{/if}
									</button>
									{#if expandedRunId === run.id && run.state !== 'scheduled'}
										<div class="mt-1 mb-1.5 ml-4 border-l-2 border-[#efede3] pl-3 text-xs">
											{#if !trace}
												<p class="text-neutral-400">{m.flow_trace_none()}</p>
											{:else}
												{#each trace.steps as step, i (i)}
													<div class="mb-1.5">
														{#if step.reasoning}<p class="text-neutral-500 italic">{step.reasoning}</p>{/if}
														{#if step.tools}
															{#each step.tools as call, j (j)}
																<p class="mt-0.5 font-mono text-[11px] text-neutral-600"><span class="rounded bg-[#f0eee6] px-1 py-px font-semibold">{call.name}</span> <span class="text-neutral-400">{call.input}</span></p>
															{/each}
														{/if}
													</div>
												{/each}
												{#if trace.error}<p class="font-medium text-red-600">{m.flow_trace_error()}: {trace.error}</p>
												{:else if trace.text}<p class="mb-0.5 font-semibold text-neutral-500">{m.flow_trace_final()}</p><p class="whitespace-pre-wrap text-neutral-700">{trace.text}</p>
												{:else}<p class="animate-pulse text-neutral-400">{m.flow_trace_working()}</p>{/if}
											{/if}
										</div>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			{/if}
		{:else}
			<div class="grid flex-1 place-items-center px-6 text-center">
				<div>
					<span class="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-[#d97757]/10 text-[#bd5d3a]">
						<Icon name="zap" size={22} />
					</span>
					<p class="text-sm font-medium text-neutral-600">{m.flow_builder_empty_title()}</p>
					<p class="mx-auto mt-1 max-w-sm text-xs text-neutral-400">{m.flow_builder_empty_sub()}</p>
				</div>
			</div>
		{/if}
	</main>
</div>

<style>
	.detail-label {
		margin-bottom: 2px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #8a8a8a;
	}
	.detail-pre {
		max-height: 16rem;
		overflow: auto;
		white-space: pre-wrap;
		word-break: break-word;
		font-size: 12px;
		line-height: 1.45;
		color: #4b4b4b;
		background: #f7f5ef;
		border-radius: 8px;
		padding: 8px 10px;
	}
</style>

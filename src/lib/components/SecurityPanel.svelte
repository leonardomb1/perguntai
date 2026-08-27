<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale } from '$lib/paraglide/runtime';
	import Avatar from './Avatar.svelte';
	import Icon from './Icon.svelte';
	import HelpTip from './HelpTip.svelte';
	import SelectMenu from './SelectMenu.svelte';
	import {
		adminRevokeKey,
		fetchAllKeys,
		fetchAudit,
		fetchConnectors,
		type AdminKeyOwner,
		type AuditEvent,
		type ConnectorUser
	} from '$lib/admin';

	/**
	 * The console's security section: every user's API keys (with admin
	 * revocation), the connector fleet (who wired which MCP server), and the
	 * audit trail — Azure-activity-log shaped: time, caller (+credential and
	 * client context), operation, target, status, expandable detail.
	 */

	let owners = $state<AdminKeyOwner[]>([]);
	let connectors = $state<ConnectorUser[]>([]);
	let events = $state<AuditEvent[]>([]);
	let loaded = $state(false);

	// Audit filters — server-side, so the 200-event window stays meaningful.
	let filterCategory = $state('');
	let filterActor = $state('');
	let expanded = $state<string | null>(null);

	const categoryOptions = $derived([
		{ value: '', label: m.audit_filter_all() },
		{ value: 'auth', label: m.audit_cat_auth() },
		{ value: 'chat', label: m.audit_cat_chat() },
		{ value: 'admin', label: m.audit_cat_admin() },
		{ value: 'keys', label: m.audit_cat_keys() },
		{ value: 'connectors', label: m.audit_cat_connectors() }
	]);

	async function refreshAll() {
		[owners, connectors] = await Promise.all([fetchAllKeys(), fetchConnectors()]);
		await refreshEvents();
		loaded = true;
	}
	async function refreshEvents() {
		events = await fetchAudit({
			category: filterCategory || undefined,
			actor: filterActor.trim() || undefined
		});
	}
	$effect(() => {
		void refreshAll();
	});

	async function revoke(username: string, id: string) {
		if (await adminRevokeKey(username, id)) owners = await fetchAllKeys();
	}

	const fmtDate = (iso: string | null) =>
		iso
			? new Date(iso).toLocaleDateString(getLocale() === 'en' ? 'en-US' : 'pt-BR', {
					day: '2-digit',
					month: 'short'
				})
			: null;
	const fmtTime = (iso: string) =>
		new Date(iso).toLocaleString(getLocale() === 'en' ? 'en-US' : 'pt-BR', {
			day: '2-digit',
			month: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		});

	const STATUS_STYLE: Record<AuditEvent['status'], string> = {
		ok: 'bg-[#1baf7a]/12 text-[#0d8a5f]',
		denied: 'bg-amber-100 text-amber-700',
		error: 'bg-red-50 text-red-600'
	};

	const keyRows = $derived(
		owners.flatMap((o) => o.keys.map((k) => ({ ...k, username: o.username })))
	);
</script>

{#if !loaded}
	<div class="grid h-40 place-items-center">
		<span class="size-6 animate-spin rounded-full border-[3px] border-[#e3e0d5] border-t-[#d97757]"></span>
	</div>
{:else}
	<!-- API keys, fleet-wide -->
	<div class="mb-4 rounded-xl border border-[#e3e0d5] bg-white">
		<div class="flex items-center gap-1.5 px-4 py-3">
			<h3 class="text-base font-semibold text-neutral-900">{m.audit_keys_title()}</h3>
			<HelpTip text={m.audit_keys_help()} />
		</div>
		{#if keyRows.length === 0}
			<p class="px-4 pb-4 text-[13px] text-neutral-400">{m.audit_keys_empty()}</p>
		{:else}
			<div class="overflow-x-auto rounded-b-xl">
				<table class="w-full text-left">
					<thead>
						<tr class="border-y border-[#efede3] bg-[#faf9f5]/60 text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">
							<th class="py-2 pl-4 font-semibold">{m.admin_col_user()}</th>
							<th class="px-3 py-2 font-semibold">{m.audit_col_label()}</th>
							<th class="px-3 py-2 font-semibold">{m.audit_col_created()}</th>
							<th class="px-3 py-2 font-semibold">{m.audit_col_lastused()}</th>
							<th class="px-3 py-2 font-semibold">{m.audit_col_expires()}</th>
							<th class="py-2 pr-4"></th>
						</tr>
					</thead>
					<tbody>
						{#each keyRows as k (k.username + k.id)}
							<tr class="border-b border-[#efede3] last:border-b-0 {k.revokedAt ? 'opacity-50' : ''}">
								<td class="py-2.5 pl-4">
									<div class="flex items-center gap-2.5">
										<Avatar username={k.username} size={24} />
										<span class="max-w-44 truncate text-[15px] font-medium text-neutral-800">{k.username}</span>
									</div>
								</td>
								<td class="px-3 py-2.5">
									<div class="flex items-center gap-2">
										<Icon name="key" size={13} class="shrink-0 text-neutral-400" />
										<span class="max-w-52 truncate text-[15px] text-neutral-800">{k.label}</span>
										{#if k.hint}
											<span class="shrink-0 font-mono text-[11px] text-neutral-400">{k.hint}</span>
										{/if}
										<span class="shrink-0 rounded bg-[#f0eee6] px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
											{k.scope === 'chat' ? m.apikeys_scope_chat() : m.apikeys_scope_full()}
										</span>
										{#if k.revokedAt}
											<span class="shrink-0 rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-red-600 uppercase">
												{m.audit_revoked()}
											</span>
										{/if}
									</div>
								</td>
								<td class="px-3 py-2.5 text-[13px] whitespace-nowrap text-neutral-500">{fmtDate(k.createdAt)}</td>
								<td class="px-3 py-2.5 text-[13px] whitespace-nowrap text-neutral-500">
									{fmtDate(k.lastUsedAt) ?? m.audit_never()}
								</td>
								<td class="px-3 py-2.5 text-[13px] whitespace-nowrap text-neutral-500">{fmtDate(k.expiresAt) ?? '∞'}</td>
								<td class="py-2.5 pr-4 text-right">
									{#if !k.revokedAt}
										<button
											onclick={() => revoke(k.username, k.id)}
											class="rounded-lg px-2.5 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50"
										>
											{m.apikeys_revoke()}
										</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

	<!-- connector fleet -->
	<div class="mb-4 rounded-xl border border-[#e3e0d5] bg-white">
		<div class="flex items-center gap-1.5 px-4 py-3">
			<h3 class="text-base font-semibold text-neutral-900">{m.audit_connectors_title()}</h3>
			<HelpTip text={m.audit_connectors_help()} />
		</div>
		{#if connectors.length === 0}
			<p class="px-4 pb-4 text-[13px] text-neutral-400">{m.audit_connectors_empty()}</p>
		{:else}
			<div class="px-4 pb-3">
				{#each connectors as c (c.username)}
					<div class="flex flex-wrap items-center gap-2 border-b border-[#efede3] py-2.5 last:border-b-0">
						<Avatar username={c.username} size={24} />
						<span class="max-w-44 truncate text-[15px] font-medium text-neutral-800">{c.username}</span>
						<span class="min-w-4 flex-1"></span>
						{#each c.mcpServers as sv (sv.name + sv.url)}
							<span
								class="rounded px-1.5 py-0.5 text-[11px] font-medium {sv.enabled
									? 'bg-[#d97757]/8 text-[#bd5d3a]'
									: 'bg-neutral-100 text-neutral-400 line-through'}"
								title={sv.url}
							>
								{sv.name || sv.url}
							</span>
						{/each}
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<!-- audit trail -->
	<div class="rounded-xl border border-[#e3e0d5] bg-white">
		<div class="flex flex-wrap items-center gap-2 px-4 py-3">
			<h3 class="flex items-center gap-1.5 text-base font-semibold text-neutral-900">
				{m.audit_log_title()}
				<HelpTip text={m.audit_log_help()} />
			</h3>
			<span class="flex-1"></span>
			<SelectMenu options={categoryOptions} bind:value={filterCategory} onSelect={() => refreshEvents()} />
			<input
				type="text"
				bind:value={filterActor}
				onkeydown={(e) => e.key === 'Enter' && refreshEvents()}
				placeholder={m.audit_actor_placeholder()}
				class="w-44 rounded-lg border border-[#e3e0d5] bg-white px-2.5 py-1.5 text-[13px] transition focus:border-[#d97757] focus:outline-none"
			/>
			<button
				onclick={refreshEvents}
				class="grid size-8 place-items-center rounded-lg border border-[#e3e0d5] text-neutral-500 transition hover:bg-[#faf9f5] hover:text-neutral-700"
				title={m.audit_refresh()}
				aria-label={m.audit_refresh()}
			>
				<Icon name="refresh" size={14} />
			</button>
		</div>
		{#if events.length === 0}
			<p class="px-4 pb-4 text-[13px] text-neutral-400">{m.audit_empty()}</p>
		{:else}
			<div class="overflow-x-auto rounded-b-xl">
				<table class="w-full text-left">
					<thead>
						<tr class="border-y border-[#efede3] bg-[#faf9f5]/60 text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">
							<th class="py-2 pl-4 font-semibold">{m.audit_col_time()}</th>
							<th class="px-3 py-2 font-semibold">{m.audit_col_actor()}</th>
							<th class="px-3 py-2 font-semibold">{m.audit_col_via()}</th>
							<th class="px-3 py-2 font-semibold">{m.audit_col_action()}</th>
							<th class="px-3 py-2 font-semibold">{m.audit_col_target()}</th>
							<th class="px-3 py-2 font-semibold">IP</th>
							<th class="py-2 pr-4 font-semibold">{m.audit_col_status()}</th>
						</tr>
					</thead>
					<tbody>
						{#each events as e, i (e.ts + i)}
							{@const rowId = e.ts + i}
							<tr
								class="cursor-pointer border-b border-[#efede3] transition last:border-b-0 hover:bg-[#faf9f5]/70"
								onclick={() => (expanded = expanded === rowId ? null : rowId)}
							>
								<td class="py-2 pl-4 text-[13px] whitespace-nowrap text-neutral-500 tabular-nums">{fmtTime(e.ts)}</td>
								<td class="px-3 py-2 text-[15px] font-medium whitespace-nowrap text-neutral-800">{e.actor}</td>
								<td class="px-3 py-2">
									{#if e.via === 'apikey'}
										<span
											class="inline-flex items-center gap-1 rounded bg-[#d97757]/8 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-[#bd5d3a]"
											title={e.keyLabel}
										>
											<Icon name="key" size={10} />{e.keyLabel ?? m.audit_via_apikey()}
										</span>
									{:else}
										<span class="rounded bg-[#f0eee6] px-1.5 py-0.5 text-[11px] font-medium text-neutral-500">{m.audit_via_session()}</span>
									{/if}
								</td>
								<td class="px-3 py-2 font-mono text-[13px] whitespace-nowrap text-neutral-700">{e.action}</td>
								<td class="max-w-44 truncate px-3 py-2 text-[13px] text-neutral-500">{e.target ?? ''}</td>
								<td class="px-3 py-2 text-[12px] whitespace-nowrap text-neutral-400 tabular-nums">{e.ip ?? ''}</td>
								<td class="py-2 pr-4">
									<span class="rounded px-1.5 py-0.5 text-[11px] font-medium {STATUS_STYLE[e.status]}">{e.status}</span>
								</td>
							</tr>
							{#if expanded === rowId}
								<tr class="border-b border-[#efede3] bg-[#faf9f5]/60 last:border-b-0">
									<td colspan="7" class="px-4 py-2.5">
										<pre class="overflow-x-auto font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-neutral-600">{JSON.stringify(
											{ ...e, detail: e.detail ?? {} },
											null,
											2
										)}</pre>
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
{/if}

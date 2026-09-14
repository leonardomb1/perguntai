<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import Icon from './Icon.svelte';
	import HelpTip from './HelpTip.svelte';
	import { egressPortsLabel, parseEgressRule, MAX_EGRESS_RULES, type EgressRule } from '$lib/egress';

	/**
	 * Sandbox egress allow-list editor — a flat block anchored inline under the
	 * grant it belongs to (a policy block or a user row): no card, no popover.
	 * Entries are typed as text and classified on the fly; invalid ones get the
	 * console's usual transient red ring. `inherited` groups render read-only,
	 * so a user row shows the effective list (own + matched policies) in place.
	 */
	let {
		rules,
		onchange,
		inherited = [],
		disabled = false
	}: {
		rules: string[];
		onchange: (next: string[]) => void;
		inherited?: { name: string; rules: string[] }[];
		disabled?: boolean;
	} = $props();

	let draft = $state('');
	let inputEl = $state<HTMLInputElement | null>(null);

	const parsed = $derived(
		rules.map((text) => parseEgressRule(text)).filter((r): r is EgressRule => r !== null)
	);
	const inheritedParsed = $derived(
		inherited
			.map((g) => ({
				name: g.name,
				rules: g.rules.map((t) => parseEgressRule(t)).filter((r): r is EgressRule => r !== null)
			}))
			.filter((g) => g.rules.length > 0)
	);
	const full = $derived(rules.length >= MAX_EGRESS_RULES);

	function add() {
		const rule = parseEgressRule(draft);
		if (!rule) {
			inputEl?.classList.add('ring-2', 'ring-red-400');
			setTimeout(() => inputEl?.classList.remove('ring-2', 'ring-red-400'), 1200);
			return;
		}
		if (!rules.includes(rule.text)) onchange([...rules, rule.text]);
		draft = '';
	}
	function remove(text: string) {
		onchange(rules.filter((r) => r !== text));
	}

	const kindLabel = (k: EgressRule['kind']) =>
		k === 'domain' ? m.egress_kind_domain() : k === 'suffix' ? m.egress_kind_suffix() : m.egress_kind_cidr();
</script>

{#snippet row(r: EgressRule, removable: boolean)}
	<li class="flex items-center gap-2 py-1.5">
		<span class="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-800" title={r.value}>{r.value}</span>
		<span class="shrink-0 rounded bg-fill px-1.5 py-0.5 text-[11px] font-medium text-neutral-500">{kindLabel(r.kind)}</span>
		<span class="w-16 shrink-0 text-right text-[12px] text-neutral-500 tabular-nums" title={m.egress_col_ports()}>{egressPortsLabel(r)}</span>
		{#if r.scope === 'private'}
			<span
				class="inline-flex w-24 shrink-0 items-center justify-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700"
				title={m.egress_private_hint()}
			>
				<Icon name="info" size={11} />
				{m.egress_scope_private()}
			</span>
		{:else}
			<span class="w-24 shrink-0 rounded bg-success/12 px-1.5 py-0.5 text-center text-[11px] font-medium text-success-strong">{m.egress_scope_public()}</span>
		{/if}
		<button
			type="button"
			onclick={() => remove(r.text)}
			disabled={disabled || !removable}
			class="shrink-0 rounded p-1 text-neutral-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-0"
			title={m.egress_remove()}
			aria-label={m.egress_remove()}
		>
			<Icon name="x" size={13} />
		</button>
	</li>
{/snippet}

<div class="max-w-2xl">
	<div class="flex items-center gap-1.5 text-[13px] font-semibold text-neutral-800">
		<Icon name="globe" size={13} class="text-neutral-500" />
		{m.egress_title()}
		<HelpTip text={m.egress_help()} />
	</div>

	{#if parsed.length === 0 && inheritedParsed.length === 0}
		<p class="mt-2 text-xs text-neutral-400">{m.egress_empty()}</p>
	{:else}
		<ul class="mt-1 divide-y divide-edge-soft">
			{#each parsed as r (r.text)}
				{@render row(r, true)}
			{/each}
			{#each inheritedParsed as g (g.name)}
				<li class="pt-2 pb-0.5 text-[11px] font-medium text-accent-strong" title={m.egress_via_policy_hint()}>
					{m.egress_via_policy({ name: g.name })}
				</li>
				{#each g.rules as r (g.name + r.text)}
					{@render row(r, false)}
				{/each}
			{/each}
		</ul>
	{/if}

	<div class="mt-2 flex items-center gap-2">
		<input
			bind:this={inputEl}
			bind:value={draft}
			onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
			placeholder={m.egress_placeholder()}
			spellcheck="false"
			autocapitalize="none"
			disabled={disabled || full}
			class="min-w-0 flex-1 rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-xs transition focus:border-accent focus:ring-2 focus:ring-accent/15 focus:outline-none disabled:opacity-50"
		/>
		<button
			type="button"
			onclick={add}
			disabled={disabled || full || !draft.trim()}
			class="shrink-0 rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition hover:border-accent/40 hover:bg-canvas hover:text-accent-strong disabled:opacity-40"
		>
			{m.egress_add()}
		</button>
	</div>
	<p class="mt-1.5 text-[11px] leading-relaxed text-neutral-400">{m.egress_denied_note()}</p>
</div>

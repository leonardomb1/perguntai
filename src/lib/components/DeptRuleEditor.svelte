<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import Icon from './Icon.svelte';
	import {
		COMMON_ATTRIBUTES,
		RULE_OPS,
		ruleMatches,
		type DeptMatch,
		type DeptRule,
		type ProfileClaims,
		type RuleOp
	} from '$lib/dept-rules';

	let {
		match = $bindable(),
		you
	}: {
		match: DeptMatch;
		/** The signed-in admin's own claims: suggestions and the live per-rule check. */
		you: ProfileClaims;
	} = $props();

	const uid = $props.id();

	const opLabel: Record<RuleOp, () => string> = {
		is: m.org_dept_op_is,
		prefix: m.org_dept_op_prefix,
		contains: m.org_dept_op_contains
	};

	// Attributes to offer: the well-known names first, then whatever the caller's
	// own sign-in carried — a claim mapped at the IdP shows up here on its own.
	const attributes = $derived([...new Set([...COMMON_ATTRIBUTES, ...Object.keys(you).sort()])]);

	function addRule(rule: DeptRule = { attribute: 'groups', op: 'is', value: '' }) {
		match = { ...match, rules: [...match.rules, rule] };
	}
	function removeRule(index: number) {
		match = { ...match, rules: match.rules.filter((_, i) => i !== index) };
	}
	function setMode(mode: DeptMatch['mode']) {
		match = { ...match, mode };
	}
	function hasRule(attribute: string, value: string): boolean {
		return match.rules.some((r) => r.attribute === attribute && r.op === 'is' && r.value === value);
	}
	// A group present both as a DN and as its bare name is shown once, by name.
	function displayValues(attribute: string, values: string[]): string[] {
		if (attribute !== 'groups') return values;
		const bare = new Set(values.filter((v) => !/^cn=/i.test(v)).map((v) => v.toLowerCase()));
		return values.filter((v) => {
			const cn = /^cn=((?:\\.|[^,])+)/i.exec(v)?.[1]?.replace(/\\(.)/g, '$1');
			return !(cn && bare.has(cn.toLowerCase()));
		});
	}
	const yourClaims = $derived(
		Object.entries(you)
			.map(([attribute, values]) => ({ attribute, values: displayValues(attribute, values) }))
			.filter((c) => c.values.length)
			// Groups last: the longest list, and the one people already know.
			.sort((a, b) =>
				a.attribute === 'groups' ? 1 : b.attribute === 'groups' ? -1 : a.attribute.localeCompare(b.attribute)
			)
	);
</script>

<div class="space-y-4">
	<!-- any / all -->
	<div class="flex flex-wrap items-center gap-2 text-xs">
		<span class="font-medium text-neutral-600">{m.org_dept_mode_label()}</span>
		<div class="flex rounded-lg border border-[#e3e0d5] bg-white p-0.5">
			{#each [['any', m.org_dept_mode_any()], ['all', m.org_dept_mode_all()]] as [mode, label] (mode)}
				<button
					type="button"
					onclick={() => setMode(mode as DeptMatch['mode'])}
					class="rounded-md px-2.5 py-1 font-medium transition
						{match.mode === mode ? 'bg-[#d97757]/12 text-[#bd5d3a]' : 'text-neutral-500 hover:text-neutral-800'}"
				>
					{label}
				</button>
			{/each}
		</div>
	</div>

	<!-- rules -->
	<datalist id="{uid}-attrs">
		{#each attributes as a (a)}<option value={a}></option>{/each}
	</datalist>

	{#if match.rules.length === 0}
		<p class="rounded-lg border border-dashed border-[#e3e0d5] px-3 py-2.5 text-xs text-neutral-400">
			{m.org_dept_rules_empty()}
		</p>
	{:else}
		<ul class="space-y-2">
			{#each match.rules as rule, i (i)}
				{@const hit = ruleMatches(rule, you)}
				<li class="flex items-center gap-2">
					<span
						class="size-1.5 shrink-0 rounded-full {hit ? 'bg-[#1baf7a]' : 'bg-neutral-300'}"
						title={hit ? m.org_dept_matches_you() : m.org_dept_matches_you_not()}
					></span>
					<input
						bind:value={rule.attribute}
						list="{uid}-attrs"
						maxlength="64"
						placeholder={m.org_dept_rule_attribute()}
						spellcheck="false"
						autocapitalize="none"
						class="w-36 shrink-0 rounded-lg border border-[#e3e0d5] bg-white px-2.5 py-1.5 font-mono text-xs transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
					/>
					<select
						bind:value={rule.op}
						class="shrink-0 rounded-lg border border-[#e3e0d5] bg-white px-2 py-1.5 text-xs transition focus:border-[#d97757] focus:outline-none"
					>
						{#each RULE_OPS as op (op)}<option value={op}>{opLabel[op]()}</option>{/each}
					</select>
					<datalist id="{uid}-v{i}">
						{#each you[rule.attribute] ?? [] as v (v)}<option value={v}></option>{/each}
					</datalist>
					<input
						bind:value={rule.value}
						list="{uid}-v{i}"
						maxlength="256"
						placeholder={m.org_dept_rule_value()}
						spellcheck="false"
						class="min-w-0 flex-1 rounded-lg border border-[#e3e0d5] bg-white px-2.5 py-1.5 text-xs transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
					/>
					<button
						type="button"
						onclick={() => removeRule(i)}
						class="grid size-7 shrink-0 place-items-center rounded-lg text-neutral-400 transition hover:bg-red-50 hover:text-red-600"
						title={m.org_dept_rule_remove()}
						aria-label={m.org_dept_rule_remove()}
					>
						<Icon name="x" size={13} />
					</button>
				</li>
			{/each}
		</ul>
	{/if}

	<button
		type="button"
		onclick={() => addRule()}
		class="flex items-center gap-1.5 rounded-lg border border-dashed border-[#d8d4c6] px-3 py-1.5 text-xs font-medium text-neutral-500 transition hover:border-[#d97757]/50 hover:bg-[#d97757]/5 hover:text-[#bd5d3a]"
	>
		<Icon name="plus" size={13} />
		{m.org_dept_rule_add()}
	</button>

	<!-- the caller's own claims, as one-click rules -->
	<div>
		<p class="mb-1.5 text-[11px] text-neutral-400">{m.org_dept_yours()}</p>
		{#if yourClaims.length === 0}
			<p class="text-[11px] text-neutral-400 italic">{m.org_dept_yours_empty()}</p>
		{:else}
			<div class="max-h-48 space-y-1.5 overflow-y-auto rounded-lg border border-[#efede3] bg-[#faf9f5] p-2">
				{#each yourClaims as { attribute, values } (attribute)}
					<div class="flex flex-wrap items-baseline gap-1.5">
						<span class="font-mono text-[10px] text-neutral-500">{attribute}</span>
						{#each values as v (v)}
							{@const used = hasRule(attribute, v)}
							<button
								type="button"
								disabled={used}
								onclick={() => addRule({ attribute, op: 'is', value: v })}
								class="flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] break-all transition
									{used
									? 'border-[#d97757]/30 bg-[#d97757]/10 text-[#bd5d3a]'
									: 'border-dashed border-[#d8d4c6] text-neutral-500 hover:border-[#d97757]/50 hover:text-[#bd5d3a]'}"
							>
								{#if !used}<Icon name="plus" size={10} />{/if}
								{v}
							</button>
						{/each}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

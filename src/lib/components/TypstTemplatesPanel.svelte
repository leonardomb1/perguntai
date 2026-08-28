<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { getToken } from '$lib/session';
	import Icon from './Icon.svelte';
	import HelpTip from './HelpTip.svelte';

	/**
	 * Organization PDF templates (console → Modelos PDF): Typst sources that
	 * wrap the model-written body (`#include "content.typ"`), so every report
	 * ships in the organization's layout. Editor + live SVG preview compiled
	 * against sample content, tabula-style.
	 */

	interface Template {
		id: string;
		name: string;
		description: string;
		source: string;
		enabled: boolean;
		updatedAt: string;
	}
	interface Diagnostic {
		severity: string;
		message: string;
		file: string;
	}

	let templates = $state<Template[] | null>(null);
	let openId = $state<string | null>(null); // null = list; '__new__' = create
	let draft = $state({ name: '', description: '', source: '' });
	let busy = $state(false);
	let previewSvg = $state<string | null>(null);
	let previewError = $state<{ message: string; diagnostics?: Diagnostic[] } | null>(null);
	let previewing = $state(false);
	let saveError = $state<string | null>(null);

	const headers = () => ({
		Authorization: `Bearer ${getToken() ?? ''}`,
		'Content-Type': 'application/json'
	});

	async function refresh() {
		const res = await fetch('/api/admin/typst-templates', { headers: headers() }).catch(() => null);
		templates = res?.ok ? ((await res.json()).templates ?? []) : [];
	}
	void refresh();

	const current = $derived(
		openId && openId !== '__new__' ? (templates?.find((t) => t.id === openId) ?? null) : null
	);

	const STARTER = `#let accent = rgb("#d97757")
#set page(paper: "a4", margin: (x: 2.2cm, y: 2.4cm), footer: context [
  #set text(size: 8pt, fill: gray)
  #h(1fr) #counter(page).display("1 / 1", both: true)
])
#set text(font: "Liberation Sans", size: 10.5pt)
#show heading.where(level: 1): it => [
  #set text(size: 18pt, fill: accent)
  #it
  #v(2pt)
  #line(length: 100%, stroke: 0.5pt + accent)
]

#include "content.typ"
`;

	function openDetail(t: Template) {
		openId = t.id;
		draft = { name: t.name, description: t.description, source: t.source };
		previewSvg = null;
		previewError = null;
		saveError = null;
	}
	function openNew() {
		openId = '__new__';
		draft = { name: '', description: '', source: STARTER };
		previewSvg = null;
		previewError = null;
		saveError = null;
	}
	function back() {
		openId = null;
		previewSvg = null;
		previewError = null;
	}

	async function preview() {
		if (previewing || !draft.source.trim()) return;
		previewing = true;
		previewError = null;
		try {
			const res = await fetch('/api/admin/typst-templates', {
				method: 'POST',
				headers: headers(),
				body: JSON.stringify({ preview: true, source: draft.source })
			});
			const data = await res.json();
			if (res.ok) previewSvg = data.svg;
			else {
				previewSvg = null;
				previewError = { message: data.error ?? 'compile failed', diagnostics: data.diagnostics };
			}
		} catch {
			previewError = { message: 'preview failed' };
		} finally {
			previewing = false;
		}
	}

	async function save() {
		if (busy || !draft.name.trim() || !draft.source.trim()) return;
		busy = true;
		saveError = null;
		const res = await fetch('/api/admin/typst-templates', {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify({
				...(openId && openId !== '__new__' ? { id: openId } : {}),
				name: draft.name.trim(),
				description: draft.description.trim(),
				source: draft.source
			})
		}).catch(() => null);
		busy = false;
		if (res?.ok) {
			const saved = (await res.json()).template as Template;
			await refresh();
			openId = saved.id;
		} else {
			const reason = res ? (await res.json().catch(() => ({}))).error : null;
			saveError = reason === 'no_include' ? m.pdft_no_include() : m.pdft_save_failed();
		}
	}

	async function toggle(t: Template) {
		await fetch('/api/admin/typst-templates', {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify({ id: t.id, enabled: !t.enabled })
		}).catch(() => null);
		await refresh();
	}

	async function remove(t: Template) {
		if (!confirm(m.pdft_delete_confirm())) return;
		await fetch(`/api/admin/typst-templates?id=${encodeURIComponent(t.id)}`, {
			method: 'DELETE',
			headers: headers()
		}).catch(() => null);
		if (openId === t.id) back();
		await refresh();
	}
</script>

{#if openId === null}
	<!-- LIST -->
	<section class="overflow-hidden rounded-xl border border-[#e3e0d5] bg-white">
		<div class="flex items-center gap-2 border-b border-[#efede3] px-4 py-3">
			<h3 class="text-sm font-semibold text-neutral-800">{m.pdft_list_title()}</h3>
			<HelpTip text={m.pdft_help()} />
			<span class="min-w-0 flex-1"></span>
			<button
				onclick={openNew}
				class="flex items-center gap-1.5 rounded-lg bg-[#d97757] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[#bd5d3a]"
			>
				<Icon name="plus" size={13} />
				{m.pdft_new()}
			</button>
		</div>
		{#if templates === null}
			<div class="grid place-items-center py-8">
				<span class="size-6 animate-spin rounded-full border-[3px] border-[#e3e0d5] border-t-[#d97757]"></span>
			</div>
		{:else if templates.length === 0}
			<p class="px-4 py-6 text-center text-xs text-neutral-400">{m.pdft_none()}</p>
		{:else}
			{#each templates as t (t.id)}
				<div class="flex items-center gap-3 border-b border-[#efede3] px-4 py-3 last:border-b-0">
					<button onclick={() => openDetail(t)} class="flex min-w-0 flex-1 items-center gap-3 text-left">
						<Icon name="file" size={15} class="shrink-0 {t.enabled ? 'text-[#bd5d3a]' : 'text-neutral-300'}" />
						<span class="min-w-0 flex-1">
							<span class="block truncate text-sm font-medium text-neutral-800">{t.name}</span>
							{#if t.description}
								<span class="block truncate text-xs text-neutral-500">{t.description}</span>
							{/if}
						</span>
					</button>
					<button
						role="switch"
						aria-checked={t.enabled}
						aria-label={t.name}
						onclick={() => toggle(t)}
						class="relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200
							{t.enabled ? 'bg-[#d97757]' : 'bg-[#d9d6c8]'}"
					>
						<span
							class="absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform duration-200
								{t.enabled ? 'translate-x-4' : 'translate-x-0'}"
						></span>
					</button>
					<button
						onclick={() => remove(t)}
						class="shrink-0 rounded p-1.5 text-neutral-400 transition hover:bg-red-50 hover:text-red-600"
						title={m.settings_memory_delete()}
						aria-label={m.settings_memory_delete()}
					>
						<Icon name="trash" size={14} />
					</button>
				</div>
			{/each}
		{/if}
	</section>
{:else}
	<!-- EDITOR + PREVIEW -->
	<div class="space-y-4">
		<div class="flex items-center gap-2">
			<button
				onclick={back}
				class="grid size-8 shrink-0 place-items-center rounded-lg text-neutral-500 transition hover:bg-[#eceae1] hover:text-neutral-800"
				aria-label={m.settings_memory_back()}
			>
				<Icon name="arrow-right" size={16} class="rotate-180" />
			</button>
			<h3 class="min-w-0 flex-1 truncate text-base font-semibold text-neutral-900">
				{openId === '__new__' ? m.pdft_new() : current?.name}
			</h3>
			<button
				onclick={preview}
				disabled={previewing}
				class="flex shrink-0 items-center gap-1.5 rounded-lg border border-[#e3e0d5] bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 transition hover:border-[#d97757]/50 hover:text-[#bd5d3a] disabled:opacity-50"
			>
				{#if previewing}
					<span class="size-3 animate-spin rounded-full border-2 border-[#e3e0d5] border-t-[#d97757]"></span>
				{:else}
					<Icon name="eye" size={13} />
				{/if}
				{m.pdft_preview()}
			</button>
			<button
				onclick={save}
				disabled={busy || !draft.name.trim() || !draft.source.trim()}
				class="shrink-0 rounded-lg bg-[#d97757] px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-[#bd5d3a] disabled:opacity-50"
			>
				{m.settings_save()}
			</button>
		</div>

		{#if saveError}
			<p class="text-xs text-red-600">{saveError}</p>
		{/if}

		<div class="grid gap-4 lg:grid-cols-2">
			<div class="space-y-3">
				<input
					bind:value={draft.name}
					maxlength="80"
					placeholder={m.pdft_name_ph()}
					class="w-full rounded-lg border border-[#e3e0d5] bg-white px-3 py-2 text-sm font-medium transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
				/>
				<input
					bind:value={draft.description}
					maxlength="200"
					placeholder={m.pdft_desc_ph()}
					class="w-full rounded-lg border border-[#e3e0d5] bg-white px-3 py-2 text-sm transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
				/>
				<textarea
					bind:value={draft.source}
					rows="24"
					spellcheck="false"
					class="w-full resize-y rounded-lg border border-[#e3e0d5] bg-white px-3 py-2 font-mono text-[12.5px] leading-relaxed transition focus:border-[#d97757] focus:ring-2 focus:ring-[#d97757]/15 focus:outline-none"
				></textarea>
				<p class="text-[11px] text-neutral-400">{m.pdft_contract()}</p>
			</div>

			<div class="min-h-0 rounded-xl border border-[#e3e0d5] bg-white p-3">
				{#if previewError}
					<p class="text-xs text-red-600">✗ {previewError.message}</p>
					{#each previewError.diagnostics ?? [] as d, i (i)}
						<p class="mt-1 font-mono text-[11px] text-red-500">{d.severity}: {d.message} ({d.file})</p>
					{/each}
				{:else if previewSvg}
					<div class="preview max-h-[70vh] overflow-auto rounded-lg border border-[#efede3] bg-[#faf9f5] p-2">
						<!-- eslint-disable-next-line svelte/no-at-html-tags — server-compiled SVG from the admin's own source -->
						{@html previewSvg}
					</div>
				{:else}
					<div class="grid h-full min-h-40 place-items-center">
						<p class="text-xs text-neutral-400">{m.pdft_preview_hint()}</p>
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.preview :global(svg) {
		width: 100%;
		height: auto;
	}
</style>

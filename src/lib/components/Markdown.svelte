<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import { browser } from '$app/environment';
	import { m } from '$lib/paraglide/messages.js';
	import { copyText } from '$lib/clipboard';
	import hljs from 'highlight.js/lib/core';
	import sql from 'highlight.js/lib/languages/sql';
	import python from 'highlight.js/lib/languages/python';
	import javascript from 'highlight.js/lib/languages/javascript';
	import typescript from 'highlight.js/lib/languages/typescript';
	import json from 'highlight.js/lib/languages/json';
	import bash from 'highlight.js/lib/languages/bash';
	import yaml from 'highlight.js/lib/languages/yaml';
	import xml from 'highlight.js/lib/languages/xml';
	import css from 'highlight.js/lib/languages/css';
	import markdown from 'highlight.js/lib/languages/markdown';

	// Core + the languages the agent actually emits keeps the bundle small
	// (full highlight.js is ~1 MB).
	hljs.registerLanguage('sql', sql);
	hljs.registerLanguage('python', python);
	hljs.registerLanguage('javascript', javascript);
	hljs.registerLanguage('typescript', typescript);
	hljs.registerLanguage('json', json);
	hljs.registerLanguage('bash', bash);
	hljs.registerLanguage('yaml', yaml);
	hljs.registerLanguage('xml', xml);
	hljs.registerLanguage('css', css);
	hljs.registerLanguage('markdown', markdown);
	const ALIASES: Record<string, string> = {
		js: 'javascript',
		ts: 'typescript',
		py: 'python',
		sh: 'bash',
		shell: 'bash',
		html: 'xml',
		yml: 'yaml',
		md: 'markdown'
	};

	let { content }: { content: string } = $props();

	/**
	 * Post-process sanitized HTML: wrap tables in a scrollable card and
	 * right-align columns whose body cells are all numeric (models often emit
	 * tables without markdown alignment markers).
	 */
	function enhance(html: string): string {
		const tpl = document.createElement('template');
		tpl.innerHTML = html;

		// Code fences → highlighted card with a language label + copy button.
		// hljs output is span-only HTML it generates from escaped text, so it
		// is safe to inject post-sanitization.
		for (const code of tpl.content.querySelectorAll('pre > code')) {
			const declared = [...code.classList]
				.find((c) => c.startsWith('language-'))
				?.slice('language-'.length)
				.toLowerCase();
			const lang = declared ? (ALIASES[declared] ?? declared) : undefined;
			if (lang && hljs.getLanguage(lang)) {
				code.innerHTML = hljs.highlight(code.textContent ?? '', { language: lang }).value;
			}
			const pre = code.parentElement!;
			const card = document.createElement('div');
			card.className = 'code-card';
			const head = document.createElement('div');
			head.className = 'code-head';
			const label = document.createElement('span');
			label.textContent = declared ?? '';
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'code-copy';
			btn.textContent = m.copy_code();
			head.append(label, btn);
			pre.replaceWith(card);
			card.append(head, pre);
		}

		for (const table of tpl.content.querySelectorAll('table')) {
			const headers = [...table.querySelectorAll('thead th')];
			const rows = [...table.querySelectorAll('tbody tr')];
			for (let c = 0; c < headers.length; c++) {
				const cells = rows
					.map((r) => r.children[c] as HTMLElement | undefined)
					.filter((td): td is HTMLElement => Boolean(td));
				const numeric =
					cells.length > 0 &&
					cells.every((td) =>
						/^[\s$€R+\-–—]*[\d.,]+\s*(%|[a-zA-Z]{0,3})?$/.test(td.textContent?.trim() ?? '')
					);
				if (numeric) {
					headers[c].classList.add('num');
					for (const td of cells) td.classList.add('num');
				}
			}
			const card = document.createElement('div');
			card.className = 'table-card';
			table.replaceWith(card);
			card.appendChild(table);
		}
		return tpl.innerHTML;
	}

	// Model output is untrusted — always sanitize before {@html}.
	// DOMPurify needs a DOM; messages only exist client-side, so SSR renders plain text.
	const html = $derived(
		browser ? enhance(DOMPurify.sanitize(marked.parse(content, { async: false }) as string)) : ''
	);

	// The copy buttons live inside {@html}, so handle their clicks by delegation.
	async function onContentClick(event: MouseEvent) {
		const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('.code-copy');
		if (!btn) return;
		const code = btn.closest('.code-card')?.querySelector('code');
		if (!code) return;
		if (await copyText(code.textContent ?? '')) {
			btn.textContent = m.code_copied();
			setTimeout(() => (btn.textContent = m.copy_code()), 1500);
		}
	}
</script>

{#if browser}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="prose-chat" onclick={onContentClick}>
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized above -->
		{@html html}
	</div>
{:else}
	<p>{content}</p>
{/if}

<style>
	.prose-chat {
		/* Assistant prose reads in serif (Claude's Tiempos feel); data surfaces
		   below (tables) stay in the UI sans. */
		font-family: var(--font-serif);
		font-size: 16px;
		line-height: 1.75;
		color: #262624;
		/* Never push the page wider — long unbroken tokens wrap, wide surfaces
		   (pre, table-card) scroll internally. */
		max-width: 100%;
		min-width: 0;
		overflow-wrap: break-word;
	}

	.prose-chat :global(> * + *) {
		margin-top: 0.9em;
	}

	.prose-chat :global(h1),
	.prose-chat :global(h2),
	.prose-chat :global(h3),
	.prose-chat :global(h4) {
		font-weight: 600;
		color: #171716;
		line-height: 1.3;
		margin-top: 1.4em;
	}
	.prose-chat :global(h1) {
		font-size: 1.35em;
	}
	.prose-chat :global(h2) {
		font-size: 1.2em;
	}
	.prose-chat :global(h3) {
		font-size: 1.05em;
	}

	.prose-chat :global(ul),
	.prose-chat :global(ol) {
		padding-left: 1.5em;
	}
	.prose-chat :global(ul) {
		list-style: disc;
	}
	.prose-chat :global(ol) {
		list-style: decimal;
	}
	.prose-chat :global(li + li) {
		margin-top: 0.3em;
	}
	.prose-chat :global(li > ul),
	.prose-chat :global(li > ol) {
		margin-top: 0.3em;
	}

	.prose-chat :global(strong) {
		font-weight: 600;
		color: #171716;
	}

	.prose-chat :global(a) {
		color: #bd5d3a;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.prose-chat :global(blockquote) {
		border-left: 3px solid #e3e0d5;
		padding-left: 1em;
		color: #52514e;
	}

	.prose-chat :global(hr) {
		border: none;
		border-top: 1px solid #e3e0d5;
	}

	/* --- code --- */
	.prose-chat :global(code) {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.86em;
		background: #f0eee6;
		border: 1px solid #e3e0d5;
		border-radius: 5px;
		padding: 0.1em 0.35em;
	}

	.prose-chat :global(pre) {
		background: #262624;
		color: #f5f4ee;
		border-radius: 10px;
		padding: 0.9em 1.1em;
		overflow-x: auto;
		font-size: 0.86em;
		line-height: 1.6;
	}
	.prose-chat :global(pre code) {
		background: transparent;
		border: none;
		padding: 0;
		font-size: inherit;
		color: inherit;
	}

	/* Code card: dark header strip with language + copy button over the pre. */
	.prose-chat :global(.code-card) {
		border-radius: 10px;
		overflow: hidden;
		background: #262624;
	}
	.prose-chat :global(.code-card pre) {
		border-radius: 0;
		margin: 0;
	}
	.prose-chat :global(.code-head) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.45em 1.1em 0.35em;
		background: #33322e;
		font-family: var(--font-sans);
		font-size: 11px;
		letter-spacing: 0.04em;
		color: #a3a19a;
	}
	.prose-chat :global(.code-copy) {
		cursor: pointer;
		font: inherit;
		color: #a3a19a;
		padding: 0.15em 0.5em;
		border-radius: 6px;
		transition: color 0.15s, background 0.15s;
	}
	.prose-chat :global(.code-copy:hover) {
		color: #f5f4ee;
		background: #45443f;
	}

	/* highlight.js palette tuned to the dark pre (#262624). */
	.prose-chat :global(.hljs-comment),
	.prose-chat :global(.hljs-quote) {
		color: #8f8d84;
		font-style: italic;
	}
	.prose-chat :global(.hljs-keyword),
	.prose-chat :global(.hljs-selector-tag),
	.prose-chat :global(.hljs-literal),
	.prose-chat :global(.hljs-name),
	.prose-chat :global(.hljs-meta) {
		color: #ec9a72;
	}
	.prose-chat :global(.hljs-string),
	.prose-chat :global(.hljs-regexp),
	.prose-chat :global(.hljs-addition) {
		color: #a5c98b;
	}
	.prose-chat :global(.hljs-number),
	.prose-chat :global(.hljs-symbol),
	.prose-chat :global(.hljs-bullet) {
		color: #c9a7ee;
	}
	.prose-chat :global(.hljs-title),
	.prose-chat :global(.hljs-section) {
		color: #85b8e6;
	}
	.prose-chat :global(.hljs-built_in),
	.prose-chat :global(.hljs-type) {
		color: #7fc5c0;
	}
	.prose-chat :global(.hljs-attr),
	.prose-chat :global(.hljs-attribute),
	.prose-chat :global(.hljs-variable),
	.prose-chat :global(.hljs-template-variable) {
		color: #e2cf7c;
	}
	.prose-chat :global(.hljs-deletion) {
		color: #e8938c;
	}
	.prose-chat :global(.hljs-emphasis) {
		font-style: italic;
	}
	.prose-chat :global(.hljs-strong) {
		font-weight: 600;
	}

	/* --- tables: bordered card, scrollable when wide --- */
	.prose-chat :global(.table-card) {
		max-width: 100%;
		width: fit-content;
		min-width: min(28rem, 100%);
		overflow-x: auto;
		border: 1px solid #e3e0d5;
		border-radius: 12px;
		background: #fcfcfb;
	}

	.prose-chat :global(table) {
		width: 100%;
		border-collapse: collapse;
		font-family: var(--font-sans);
		font-size: 14px;
		font-variant-numeric: tabular-nums;
	}

	.prose-chat :global(th),
	.prose-chat :global(td) {
		padding: 0.55em 1em;
		text-align: left;
		border-bottom: 1px solid #eceade;
		white-space: nowrap;
	}

	.prose-chat :global(th.num),
	.prose-chat :global(td.num),
	.prose-chat :global(th[align='right']),
	.prose-chat :global(td[align='right']) {
		text-align: right;
	}

	.prose-chat :global(thead th) {
		font-weight: 600;
		color: #52514e;
		font-size: 0.9em;
		background: #f0eee6;
		border-bottom: 1px solid #d9d6c8;
	}

	.prose-chat :global(tbody tr:hover) {
		background: #faf9f5;
	}
	.prose-chat :global(tbody tr:last-child td) {
		border-bottom: none;
	}
</style>

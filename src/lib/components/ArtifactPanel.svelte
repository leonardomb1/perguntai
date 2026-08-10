<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import Icon from './Icon.svelte';
	import Markdown from './Markdown.svelte';
	import { artifactPanel, closeArtifact } from '$lib/artifact-panel.svelte';

	const view = $derived(artifactPanel.view);

	let objectUrl = $state<string | null>(null);
	let text = $state<string | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(false);
	let downloadError = $state<string | null>(null);

	// Reload whenever the shown artifact changes; revoke the previous blob URL.
	$effect(() => {
		const current = view;
		objectUrl = null;
		text = null;
		error = null;
		downloadError = null;
		if (!current) return;
		loading = true;
		let stale = false;
		let created: string | null = null;
		void current.load().then((res) => {
			if (stale) {
				if (res.objectUrl) URL.revokeObjectURL(res.objectUrl);
				return;
			}
			loading = false;
			error = res.error ?? null;
			text = res.text ?? null;
			objectUrl = created = res.objectUrl ?? null;
		});
		return () => {
			stale = true;
			if (created) URL.revokeObjectURL(created);
		};
	});

	async function download() {
		if (!view) return;
		downloadError = await view.download();
	}
</script>

{#if view}
	<aside class="panel">
		<header>
			<span class="head-main">
				<span class="title">{view.title}</span>
				<span class="badge">{view.badge}</span>
			</span>
			<span class="head-actions">
				{#if downloadError}
					<span class="dl-error">{downloadError}</span>
				{/if}
				<button type="button" class="act" onclick={download} title={m.download()} aria-label={m.download()}>
					<Icon name="download" size={15} />
				</button>
				<button type="button" class="act" onclick={closeArtifact} title={m.artifact_close()} aria-label={m.artifact_close()}>
					<Icon name="x" size={16} />
				</button>
			</span>
		</header>

		<div class="body" class:padded={view.kind !== 'pdf'}>
			{#if loading}
				<div class="center">
					<span class="spinner"></span>
				</div>
			{:else if error}
				<p class="error">{error}</p>
			{:else if view.kind === 'pdf' && objectUrl}
				<iframe src={objectUrl} title={view.title}></iframe>
			{:else if view.kind === 'markdown' && text !== null}
				<Markdown content={text} />
			{:else if text !== null}
				<pre>{text}</pre>
			{/if}
		</div>
	</aside>
{/if}

<style>
	.panel {
		display: flex;
		flex-direction: column;
		width: min(46vw, 760px);
		min-width: 380px;
		border-left: 1px solid #e3e0d5;
		background: #fff;
	}
	@media (max-width: 900px) {
		.panel {
			position: fixed;
			inset: 0;
			z-index: 40;
			width: auto;
			min-width: 0;
		}
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 10px 14px;
		border-bottom: 1px solid #e3e0d5;
	}
	.head-main {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 14px;
		font-weight: 600;
		color: #262624;
	}
	.badge {
		flex: none;
		padding: 1px 7px;
		border: 1px solid #e3e0d5;
		border-radius: 999px;
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.04em;
		color: #73726c;
	}
	.head-actions {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.dl-error {
		font-size: 11px;
		color: #b3261e;
	}
	.act {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		border: 0;
		border-radius: 8px;
		background: none;
		color: #73726c;
		cursor: pointer;
	}
	.act:hover {
		background: #f0efea;
		color: #262624;
	}

	.body {
		flex: 1;
		min-height: 0;
		overflow: auto;
	}
	.body.padded {
		padding: 20px 24px;
	}
	iframe {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
	}
	pre {
		margin: 0;
		font-size: 12.5px;
		line-height: 1.55;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.center {
		display: grid;
		place-items: center;
		height: 100%;
	}
	.spinner {
		width: 24px;
		height: 24px;
		border: 3px solid #e3e0d5;
		border-top-color: #d97757;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.error {
		margin: 20px;
		font-size: 13px;
		color: #b3261e;
	}
</style>

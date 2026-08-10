<script lang="ts">
	import SelectMenu from './SelectMenu.svelte';
	import { providerLogo } from '$lib/providers';
	import type { Provider } from '$lib/models';

	type Model = { id: string; label: string; hint?: string; provider: Provider };

	let {
		models,
		value = $bindable(),
		onSelect
	}: {
		models: Model[];
		value: string;
		onSelect?: (id: string) => void;
	} = $props();

	// SelectMenu keys options by `value`; carry the provider through for the logo.
	const options = $derived(
		models.map((mo) => ({ value: mo.id, label: mo.label, hint: mo.hint, provider: mo.provider }))
	);
</script>

<SelectMenu {options} bind:value {onSelect} direction="up" menuClass="min-w-[15rem]">
	{#snippet leading(o)}
		<img src={providerLogo(o.provider)} alt="" class="size-4 shrink-0" />
	{/snippet}
</SelectMenu>

<script lang="ts">
	/**
	 * Auto-generated identicon (GitHub/GitLab style): a 5×5 horizontally
	 * mirrored pixel pattern + hue, both derived deterministically from the
	 * username, so every user gets a distinct, stable avatar.
	 */
	let { username, size = 32 }: { username: string; size?: number } = $props();

	const COLORS = [
		'#d97757', // terracotta
		'#2a78d6',
		'#1baf7a',
		'#eda100',
		'#4a3aa7',
		'#e34948',
		'#e87ba4',
		'#008300'
	];

	// FNV-1a hash of the username seeds a small PRNG — raw FNV parity bits are
	// too correlated across similar strings and produce near-identical stripes.
	function hash(s: string): number {
		let h = 0x811c9dc5;
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		return h >>> 0;
	}

	function mulberry32(a: number): () => number {
		return () => {
			a |= 0;
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	const seed = $derived(hash(username.toLowerCase()));
	// FNV's low bits cluster for similar names — draw the color slot from the
	// PRNG (with a golden-ratio offset so it's independent of the pattern draw).
	const color = $derived(
		COLORS[Math.floor(mulberry32(seed ^ 0x9e3779b9)() * COLORS.length)]
	);

	// Fill the left 3 columns of a 5×5 grid; mirror to the right.
	const cells = $derived.by(() => {
		const rand = mulberry32(seed);
		const on: { x: number; y: number }[] = [];
		for (let x = 0; x < 3; x++) {
			for (let y = 0; y < 5; y++) {
				if (rand() < 0.5) {
					on.push({ x, y });
					if (x < 2) on.push({ x: 4 - x, y });
				}
			}
		}
		// An all-off draw would render blank — guarantee a center dot.
		if (on.length === 0) on.push({ x: 2, y: 2 });
		return on;
	});
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 7 7"
	class="shrink-0 rounded-md border border-black/10"
	style:background-color="{color}1a"
	role="img"
	aria-label={username}
>
	<title>{username}</title>
	{#each cells as cell (cell.x + '-' + cell.y)}
		<rect x={cell.x + 1} y={cell.y + 1} width="1" height="1" fill={color} />
	{/each}
</svg>

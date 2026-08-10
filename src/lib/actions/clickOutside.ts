interface Options {
	/** Only react while this returns true — lets a shared-state menu register one
	 *  active listener at a time, so re-clicking the trigger toggles cleanly
	 *  instead of another instance's handler resetting state first. */
	enabled?: () => boolean;
	onOutside: () => void;
}

/**
 * Svelte action: call `onOutside` when a pointer press lands outside `node`.
 * Uses capture-phase `pointerdown` so a popover closes before other handlers
 * run, and ignores presses inside the node (the trigger lives inside it, so
 * toggling still works). Reads `enabled`/`onOutside` live at event time.
 */
export function clickOutside(node: HTMLElement, options: Options) {
	let opts = options;
	const handler = (event: PointerEvent) => {
		if (opts.enabled && !opts.enabled()) return;
		if (!node.contains(event.target as Node)) opts.onOutside();
	};
	document.addEventListener('pointerdown', handler, true);
	return {
		update(next: Options) {
			opts = next;
		},
		destroy() {
			document.removeEventListener('pointerdown', handler, true);
		}
	};
}

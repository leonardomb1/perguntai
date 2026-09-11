import { browser } from '$app/environment';

/**
 * Draggable width for a sidebar column, persisted per key. Attach `startDrag`
 * to a thin handle on the panel's edge; double-click the handle to reset.
 */
export function createPanelWidth(key: string, fallback: number, min = 208, max = 480) {
	let width = $state(fallback);
	if (browser) {
		try {
			const stored = Number(localStorage.getItem(key));
			if (Number.isFinite(stored) && stored >= min && stored <= max) width = stored;
		} catch {
			// Storage unavailable — live with the default.
		}
	}
	const clamp = (w: number) => Math.min(max, Math.max(min, Math.round(w)));
	return {
		get width() {
			return width;
		},
		reset() {
			width = fallback;
			try {
				localStorage.removeItem(key);
			} catch {
				// ignore
			}
		},
		startDrag(e: PointerEvent) {
			e.preventDefault();
			const startX = e.clientX;
			const startW = width;
			const move = (ev: PointerEvent) => {
				width = clamp(startW + ev.clientX - startX);
			};
			const stop = () => {
				window.removeEventListener('pointermove', move);
				try {
					localStorage.setItem(key, String(width));
				} catch {
					// ignore
				}
			};
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', stop, { once: true });
		}
	};
}

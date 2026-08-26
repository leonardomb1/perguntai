/**
 * Place a dropdown menu next to its trigger using viewport coordinates, for use
 * with `position: fixed` menus. Fixed positioning keeps the menu out of the
 * trigger's scroll container, so it never expands that container's scroll area
 * or gets clipped by its overflow — the failure mode of an `absolute` menu
 * inside a scrollable modal.
 */
export function placeMenu(
	anchor: DOMRect,
	menuHeight: number,
	opts: { align: 'left' | 'right'; direction: 'up' | 'down'; gap?: number; minWidth?: number }
): { left: number; top: number; minWidth: number } {
	const gap = opts.gap ?? 4;
	const margin = 8;
	const minWidth = Math.max(anchor.width, opts.minWidth ?? 176);
	const spaceBelow = window.innerHeight - anchor.bottom;
	const h = menuHeight || 240;
	// Prefer the requested direction; flip only if the preferred side lacks room
	// and the other side has more.
	const openUp =
		opts.direction === 'up'
			? anchor.top > h + gap || anchor.top > spaceBelow
			: spaceBelow < h + gap && anchor.top > spaceBelow;

	let left = opts.align === 'right' ? anchor.right - minWidth : anchor.left;
	left = Math.max(margin, Math.min(left, window.innerWidth - minWidth - margin));

	const top = openUp
		? Math.max(margin, anchor.top - gap - h)
		: Math.min(anchor.bottom + gap, window.innerHeight - h - margin);

	return { left, top, minWidth };
}

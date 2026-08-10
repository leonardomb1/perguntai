/**
 * Chart color system. Categorical hues are assigned in FIXED order by series
 * index — never cycled or reshuffled — so a series keeps its color across
 * charts. Palette is CVD-validated (deuteranopia/protanopia/tritanopia
 * adjacent-pair separation) for a light surface.
 */
export const CATEGORICAL = [
	'#2a78d6', // blue
	'#1baf7a', // aqua
	'#eda100', // yellow
	'#008300', // green
	'#4a3aa7', // violet
	'#e34948', // red
	'#e87ba4', // magenta
	'#eb6834' // orange
] as const;

export const INK = {
	primary: '#0b0b0b',
	secondary: '#52514e',
	muted: '#898781',
	gridline: '#e1e0d9',
	baseline: '#c3c2b7',
	surface: '#fcfcfb'
} as const;

export function seriesColor(index: number): string {
	// More series than slots folds into repeats of the last slot rather than
	// inventing hues; the model is instructed to keep charts ≤ 8 series.
	return CATEGORICAL[Math.min(index, CATEGORICAL.length - 1)];
}

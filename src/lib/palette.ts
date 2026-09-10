/**
 * Chart color system. Categorical hues are assigned in FIXED order by series
 * index — never cycled or reshuffled — so a series keeps its color across
 * charts. Both columns are validated (CVD adjacent-pair separation, normal-
 * vision floor, lightness band, contrast) against their own surface: the dark
 * column is the same eight hues re-stepped for the dark surface, not a flip.
 */
export const CATEGORICAL = [
	'#2a78d6', // blue
	'#eb6834', // orange
	'#1baf7a', // aqua
	'#eda100', // yellow
	'#e87ba4', // magenta
	'#008300', // green
	'#4a3aa7', // violet
	'#e34948' // red
] as const;

export const CATEGORICAL_DARK = [
	'#3987e5',
	'#d95926',
	'#199e70',
	'#c98500',
	'#d55181',
	'#008300',
	'#9085e9',
	'#e66767'
] as const;

export const INK = {
	primary: '#0b0b0b',
	secondary: '#52514e',
	muted: '#898781',
	gridline: '#e1e0d9',
	baseline: '#c3c2b7',
	surface: '#fcfcfb'
} as const;

export const INK_DARK = {
	primary: '#f0efe9',
	secondary: '#aaa79f',
	muted: '#94908a',
	gridline: '#3a3835',
	baseline: '#55524b',
	surface: '#262624'
} as const;

export interface ChartInk {
	primary: string;
	secondary: string;
	muted: string;
	gridline: string;
	baseline: string;
	surface: string;
}

export function chartInk(dark: boolean): ChartInk {
	return dark ? INK_DARK : INK;
}

export function seriesColor(index: number, dark = false): string {
	// More series than slots folds into repeats of the last slot rather than
	// inventing hues; the model is instructed to keep charts ≤ 8 series.
	const palette = dark ? CATEGORICAL_DARK : CATEGORICAL;
	return palette[Math.min(index, palette.length - 1)];
}

import { browser } from '$app/environment';
import { readonly, writable } from 'svelte/store';

/**
 * Appearance: light, dark, or follow the OS. The class flip is instant; the
 * choice persists in localStorage (pre-login / first paint — see the boot
 * script in app.html) and in the per-user settings store, so it follows the
 * user across machines (the Snowsight model). Server value wins on load.
 */

export type Appearance = 'light' | 'dark' | 'system';

const KEY = 'perguntai_theme';
const mql = browser ? window.matchMedia('(prefers-color-scheme: dark)') : null;

const darkState = writable(browser ? document.documentElement.classList.contains('dark') : false);
/** Live dark-mode flag for theme-aware rendering (charts, diagrams). */
export const darkTheme = readonly(darkState);

function setClass(dark: boolean) {
	document.documentElement.classList.toggle('dark', dark);
	darkState.set(dark);
}

function onSystemChange(e: MediaQueryListEvent) {
	if (getAppearance() === 'system') setClass(e.matches);
}
mql?.addEventListener('change', onSystemChange);

export function getAppearance(): Appearance {
	if (!browser) return 'system';
	const v = localStorage.getItem(KEY);
	return v === 'light' || v === 'dark' ? v : 'system';
}

export function applyAppearance(appearance: Appearance) {
	if (!browser) return;
	try {
		localStorage.setItem(KEY, appearance);
	} catch {
		/* private mode */
	}
	setClass(appearance === 'dark' || (appearance === 'system' && !!mql?.matches));
}

/** Adopt the server-stored preference when it differs from this browser's. */
export function syncAppearance(appearance: Appearance | undefined) {
	if (!browser || !appearance) return;
	if (appearance !== getAppearance()) applyAppearance(appearance);
}

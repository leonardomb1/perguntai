import { browser } from '$app/environment';

/**
 * Tab-strip status: the favicon grows a small clock badge while a turn runs
 * and a green check when it finishes — GitHub-style, the check is meant for
 * the BACKGROUNDED tab, so it holds until the user comes back and only then
 * reverts. A visible tab just gets a brief green flash.
 *
 * Safari ignores dynamic favicons; it simply keeps the static one.
 */

const BUBBLE = `<path d="M32 4C16.8 4 4.5 14.9 4.5 28.3c0 7.5 3.9 14.2 10 18.6-.3 3.5-1.7 7.1-4.4 10.2-.6.7 0 1.8.9 1.7 6-.7 10.9-2.9 14.5-5.5 2.1.4 4.3.6 6.5.6 15.2 0 27.5-10.9 27.5-24.3S47.2 4 32 4z" fill="#d97757"/><path d="M24.5 22.5c.5-4.3 4-7 8-7 4.3 0 7.8 3 7.8 7 0 3.4-2.2 5.1-4.6 6.9-2.1 1.6-3.4 2.8-3.4 5.6" stroke="#fcfcfb" stroke-width="5.2" fill="none" stroke-linecap="round"/><circle cx="32.3" cy="43.8" r="3.4" fill="#fcfcfb"/>`;

/** The bubble with a transparent ring cut for the badge, so it reads on any tab strip. */
const badged = (badge: string) =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><mask id="m"><rect width="64" height="64" fill="white"/><circle cx="46" cy="46" r="19" fill="black"/></mask><g mask="url(#m)">${BUBBLE}</g>${badge}</svg>`;

const RUNNING = badged(
	`<circle cx="46" cy="46" r="15" fill="#b45309"/><path d="M46 37.5V46l6 4" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
);

const DONE = badged(
	`<circle cx="46" cy="46" r="15" fill="#1a7f37"/><path d="m39 46.5 5 5 9-10" stroke="#fff" stroke-width="4.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
);

type State = 'idle' | 'running' | 'done';
let state: State = 'idle';
let revertTimer: ReturnType<typeof setTimeout> | undefined;
let watchingVisibility = false;

// Chrome ignores in-place href changes on a favicon link; replacing the node
// is the reliable way to make the tab repaint.
function setIcon(href: string) {
	for (const el of document.querySelectorAll('link[rel="icon"]')) el.remove();
	const link = document.createElement('link');
	link.rel = 'icon';
	link.type = 'image/svg+xml';
	link.href = href;
	document.head.appendChild(link);
}

const uri = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

function onVisible() {
	if (document.visibilityState !== 'visible' || state !== 'done') return;
	clearTimeout(revertTimer);
	revertTimer = setTimeout(faviconReset, 1500);
}

export function faviconRunning() {
	if (!browser) return;
	clearTimeout(revertTimer);
	state = 'running';
	setIcon(uri(RUNNING));
	if (!watchingVisibility) {
		watchingVisibility = true;
		document.addEventListener('visibilitychange', onVisible);
	}
}

/** Green only after an actual run — the mount-time 'ready' state stays idle. */
export function faviconDone() {
	if (!browser || state !== 'running') return;
	state = 'done';
	setIcon(uri(DONE));
	if (document.visibilityState === 'visible') {
		revertTimer = setTimeout(faviconReset, 2500);
	}
	// Hidden tab: onVisible schedules the revert when the user returns.
}

export function faviconReset() {
	if (!browser) return;
	clearTimeout(revertTimer);
	state = 'idle';
	setIcon('/favicon.svg');
}

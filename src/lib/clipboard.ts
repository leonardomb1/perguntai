/**
 * Copy with insecure-origin fallback: navigator.clipboard only exists in
 * secure contexts (https/localhost), and the app is often served over plain
 * http on the LAN — fall back to the legacy textarea + execCommand path.
 * Returns whether the copy actually happened, so callers only show success
 * feedback when it's true.
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		/* permission denied — try the fallback */
	}
	try {
		const area = document.createElement('textarea');
		area.value = text;
		area.setAttribute('readonly', '');
		area.style.position = 'fixed';
		area.style.opacity = '0';
		document.body.appendChild(area);
		area.select();
		const ok = document.execCommand('copy');
		area.remove();
		return ok;
	} catch {
		return false;
	}
}

/**
 * Rasterize rendered charts (canvas) and Mermaid diagrams (SVG) to PNG, for
 * download or clipboard. Copying images needs the async Clipboard API, which
 * only exists in secure contexts (https/localhost) — there is no legacy
 * fallback for images, so callers should hide the copy affordance when
 * `canCopyImage()` is false. Download works everywhere.
 */

export function canCopyImage(): boolean {
	return (
		typeof ClipboardItem !== 'undefined' &&
		typeof navigator !== 'undefined' &&
		!!navigator.clipboard?.write
	);
}

export async function copyImage(blob: Blob): Promise<boolean> {
	try {
		await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
		return true;
	} catch {
		return false;
	}
}

export function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

export function pngFilename(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
	return `${slug || 'imagem'}.png`;
}

/**
 * Chart canvas → PNG with padding, background and the title drawn on top
 * (the on-screen title lives in HTML, outside the canvas). The source canvas
 * is already devicePixelRatio-scaled, so paddings scale with it.
 */
export function chartToPng(
	source: HTMLCanvasElement,
	title: string,
	background: string
): Promise<Blob | null> {
	const dpr = Math.max(1, window.devicePixelRatio || 1);
	const pad = 20 * dpr;
	const titleHeight = title ? 30 * dpr : 0;

	const out = document.createElement('canvas');
	out.width = source.width + pad * 2;
	out.height = source.height + pad * 2 + titleHeight;
	const ctx = out.getContext('2d')!;
	ctx.fillStyle = background;
	ctx.fillRect(0, 0, out.width, out.height);
	if (title) {
		ctx.fillStyle = '#262624';
		ctx.font = `600 ${14 * dpr}px 'DM Sans Variable', ui-sans-serif, system-ui, sans-serif`;
		ctx.textBaseline = 'top';
		ctx.fillText(title, pad, pad);
	}
	ctx.drawImage(source, pad, pad + titleHeight);
	return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
}

/** Mermaid SVG markup → PNG at 2x for crisp text. */
export async function svgToPng(
	svgMarkup: string,
	background: string,
	scale = 2
): Promise<Blob | null> {
	const doc = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml');
	const svg = doc.documentElement;
	if (svg.nodeName !== 'svg') return null;

	// Intrinsic size: mermaid emits a viewBox plus width:100%/max-width styles.
	let width = 0;
	let height = 0;
	const viewBox = svg.getAttribute('viewBox');
	if (viewBox) {
		const parts = viewBox.trim().split(/[\s,]+/).map(Number);
		width = parts[2] ?? 0;
		height = parts[3] ?? 0;
	}
	if (!width || !height) {
		width = parseFloat(svg.getAttribute('width') ?? '0');
		height = parseFloat(svg.getAttribute('height') ?? '0');
	}
	if (!width || !height) return null;

	svg.setAttribute('width', String(width));
	svg.setAttribute('height', String(height));
	(svg as unknown as HTMLElement).style.maxWidth = 'none';

	const xml = new XMLSerializer().serializeToString(svg);
	const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
	try {
		const img = new Image();
		await new Promise((resolve, reject) => {
			img.onload = resolve;
			img.onerror = reject;
			img.src = url;
		});
		const canvas = document.createElement('canvas');
		canvas.width = Math.round(width * scale);
		canvas.height = Math.round(height * scale);
		const ctx = canvas.getContext('2d')!;
		ctx.fillStyle = background;
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
		return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
	} catch {
		return null;
	} finally {
		URL.revokeObjectURL(url);
	}
}

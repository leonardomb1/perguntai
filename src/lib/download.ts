import { getToken } from '$lib/session';
import { m } from '$lib/paraglide/messages.js';

/**
 * Downloads a generated export. Plain <a href> can't carry the bearer token,
 * so fetch with auth and hand the blob to the browser.
 */
async function fetchAuthed(url: string): Promise<{ blob?: Blob; error?: string }> {
	try {
		const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } });
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			return { error: data.error ?? `${m.download_failed()} (${res.status})` };
		}
		return { blob: await res.blob() };
	} catch {
		return { error: m.download_failed() };
	}
}

export async function fetchExportBlob(
	fileId: string,
	filename: string
): Promise<{ blob?: Blob; error?: string }> {
	return fetchAuthed(
		`/api/exports?id=${encodeURIComponent(fileId)}&name=${encodeURIComponent(filename)}`
	);
}

function saveBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

export async function downloadExport(fileId: string, filename: string): Promise<string | null> {
	const { blob, error } = await fetchExportBlob(fileId, filename);
	if (!blob) return error ?? m.download_failed();
	saveBlob(blob, filename);
	return null;
}


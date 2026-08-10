import { extractText, getDocumentProxy } from 'unpdf';

/** File types accepted into a shared document library (text + PDF). */
export const SHARED_TEXT_TYPES = /\.(txt|md|markdown|json|sql|log)$/i;
export const PDF_TYPE = /\.pdf$/i;

/**
 * Extract a PDF's text layer server-side (via unpdf, a serverless pdf.js build —
 * no native deps). Scanned/image-only PDFs have no text layer and return ''; the
 * caller rejects those rather than storing an empty document.
 */
export async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
	const pdf = await getDocumentProxy(new Uint8Array(buffer));
	const { text } = await extractText(pdf, { mergePages: true });
	return Array.isArray(text) ? text.join('\n\n') : (text ?? '');
}

/** Read an uploaded File to plain text based on its extension (text or PDF). */
export async function fileToText(file: File): Promise<string> {
	if (PDF_TYPE.test(file.name)) return extractPdfText(await file.arrayBuffer());
	return file.text();
}

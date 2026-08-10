import * as XLSX from 'xlsx';
import type { SheetData } from './rag';

/**
 * Parse a CSV/Excel workbook into per-sheet columns + typed rows. Hardened for
 * real-world spreadsheets: it detects the header row (skipping title/blank rows
 * above it), names unnamed columns, drops fully-empty rows, and infers a type
 * per column so downstream analysis (previewTable, runPython) gets clean data.
 */
export function parseWorkbook(buffer: Buffer): SheetData[] {
	const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
	return wb.SheetNames.map((name) => parseSheet(name, wb.Sheets[name])).filter(
		(s): s is SheetData => s !== null
	);
}

function isBlank(v: unknown): boolean {
	return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/**
 * Pick the header row: the first "dense" row among the first 20. Sparse leading
 * rows (a title, a blank line, a note) are skipped; a clean sheet returns 0.
 */
function detectHeaderRow(aoa: unknown[][]): number {
	const counts = aoa.slice(0, 20).map((row) => row.filter((c) => !isBlank(c)).length);
	const max = Math.max(0, ...counts);
	if (max === 0) return 0;
	const threshold = Math.max(2, Math.floor(max * 0.7));
	const idx = counts.findIndex((c) => c >= threshold);
	return idx < 0 ? 0 : idx;
}

function cleanColumns(rawHeader: unknown[]): string[] {
	const seen = new Map<string, number>();
	return rawHeader.map((h, i) => {
		let base = isBlank(h) || String(h).startsWith('__EMPTY') ? `Coluna ${i + 1}` : String(h).trim();
		// Disambiguate duplicate headers.
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		if (n > 0) base = `${base} (${n + 1})`;
		return base;
	});
}

function cell(v: unknown): unknown {
	if (v instanceof Date) return v.toISOString();
	return v === undefined ? null : v;
}

/** Infer a coarse type per column from its non-null sample values. */
function inferTypes(columns: string[], rows: Record<string, unknown>[]): Record<string, string> {
	const types: Record<string, string> = {};
	const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}(T|\b)/.test(s);
	for (const col of columns) {
		let num = 0,
			date = 0,
			bool = 0,
			text = 0,
			seen = 0;
		for (const row of rows) {
			const v = row[col];
			if (isBlank(v)) continue;
			seen++;
			if (seen > 200) break;
			if (typeof v === 'number') num++;
			else if (typeof v === 'boolean') bool++;
			else if (typeof v === 'string' && isDate(v)) date++;
			else text++;
		}
		if (seen === 0) types[col] = 'empty';
		else if (num === seen) types[col] = 'number';
		else if (date === seen) types[col] = 'date';
		else if (bool === seen) types[col] = 'boolean';
		else types[col] = 'text';
	}
	return types;
}

function parseSheet(name: string, ws: XLSX.WorkSheet): SheetData | null {
	const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
		header: 1,
		raw: true,
		blankrows: false,
		defval: null
	});
	if (aoa.length === 0) return null;

	const headerIdx = detectHeaderRow(aoa);
	const columns = cleanColumns(aoa[headerIdx] ?? []);
	if (columns.length === 0) return null;

	const rows = aoa
		.slice(headerIdx + 1)
		.filter((r) => r.some((c) => !isBlank(c)))
		.map((r) => Object.fromEntries(columns.map((col, i) => [col, cell(r[i])])));
	if (rows.length === 0) return null;

	return { name, columns, rows, truncated: false, columnTypes: inferTypes(columns, rows) };
}

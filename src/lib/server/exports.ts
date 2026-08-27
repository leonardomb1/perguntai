import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { env } from '$env/dynamic/private';

/**
 * Generated files (.xlsx reports, .md/.txt/.csv documents), stored per-user
 * under DATA_DIR/exports. Files are addressed by random UUID and downloaded
 * through the authenticated /api/exports endpoint; old exports are pruned
 * opportunistically.
 */

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const EXPORT_TYPES = {
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	md: 'text/markdown; charset=utf-8',
	txt: 'text/plain; charset=utf-8',
	csv: 'text/csv; charset=utf-8',
	json: 'application/json; charset=utf-8',
	html: 'text/html; charset=utf-8',
	pdf: 'application/pdf',
	png: 'image/png'
} as const;
export type ExportExt = keyof typeof EXPORT_TYPES;

export interface ExportSheet {
	name: string;
	columns?: string[];
	rows: Record<string, unknown>[];
}

function userDir(username: string): string {
	const safe = username.replace(/[^a-zA-Z0-9._-]/g, '_');
	return join(env.DATA_DIR ?? 'data', 'exports', safe);
}

export async function createExcelExport(
	username: string,
	sheets: ExportSheet[]
): Promise<{ id: string; bytes: number }> {
	const workbook = XLSX.utils.book_new();
	for (const sheet of sheets) {
		const ws = XLSX.utils.json_to_sheet(sheet.rows, {
			header: sheet.columns ?? (sheet.rows[0] ? Object.keys(sheet.rows[0]) : [])
		});
		// Excel caps sheet names at 31 chars and forbids []:*?/\
		const name = sheet.name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet';
		XLSX.utils.book_append_sheet(workbook, ws, name);
	}
	const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

	const dir = userDir(username);
	await mkdir(dir, { recursive: true });
	const id = randomUUID();
	await writeFile(join(dir, `${id}.xlsx`), buffer);

	void pruneOldExports(dir);
	return { id, bytes: buffer.length };
}

/** Text document export (Markdown, plain text, CSV). */
export async function createTextExport(
	username: string,
	content: string,
	ext: Exclude<ExportExt, 'xlsx'>
): Promise<{ id: string; bytes: number }> {
	return createFileExport(username, Buffer.from(content, 'utf8'), ext);
}

/** Arbitrary generated file (sandbox workspace deliveries and the like). */
export async function createFileExport(
	username: string,
	buffer: Buffer,
	ext: ExportExt
): Promise<{ id: string; bytes: number }> {
	const dir = userDir(username);
	await mkdir(dir, { recursive: true });
	const id = randomUUID();
	await writeFile(join(dir, `${id}.${ext}`), buffer);

	void pruneOldExports(dir);
	return { id, bytes: buffer.length };
}

export async function readExport(
	username: string,
	id: string
): Promise<{ buffer: Buffer; ext: ExportExt } | null> {
	if (!/^[a-f0-9-]{36}$/.test(id)) return null;
	for (const ext of Object.keys(EXPORT_TYPES) as ExportExt[]) {
		try {
			return { buffer: await readFile(join(userDir(username), `${id}.${ext}`)), ext };
		} catch {
			/* try next extension */
		}
	}
	return null;
}

async function pruneOldExports(dir: string): Promise<void> {
	try {
		const cutoff = Date.now() - RETENTION_MS;
		for (const file of await readdir(dir)) {
			const path = join(dir, file);
			const info = await stat(path);
			if (info.mtimeMs < cutoff) await unlink(path).catch(() => {});
		}
	} catch {
		/* best-effort cleanup */
	}
}

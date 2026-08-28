import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';

/**
 * Admin-curated Typst templates for generatePdf: the template is the MAIN
 * file (page setup, brand header/footer, show rules) and must contain
 * `#include "content.typ"` where the document body goes — the model then
 * writes ONLY the body, and every report ships in the organization's layout.
 * One admin-owned file at DATA_DIR/typst-templates.json.
 */

export interface TypstTemplate {
	id: string;
	name: string;
	/** One line — advertised to the model so it picks the right template. */
	description: string;
	source: string;
	enabled: boolean;
	updatedAt: string;
}

const MAX_TEMPLATES = 20;
const MAX_SOURCE = 60_000;
export const TEMPLATE_CONTENT_FILE = 'content.typ';

function storePath(): string {
	return join(env.DATA_DIR ?? 'data', 'typst-templates.json');
}

function normalize(t: Record<string, unknown>): TypstTemplate {
	return {
		id: typeof t.id === 'string' && t.id ? t.id : crypto.randomUUID(),
		name: typeof t.name === 'string' ? t.name.slice(0, 80) : '',
		description: typeof t.description === 'string' ? t.description.slice(0, 200) : '',
		source: typeof t.source === 'string' ? t.source.slice(0, MAX_SOURCE) : '',
		enabled: t.enabled !== false,
		updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : new Date().toISOString()
	};
}

async function readAll(): Promise<TypstTemplate[]> {
	try {
		const parsed = JSON.parse(await readFile(storePath(), 'utf8'));
		const list: unknown[] = Array.isArray(parsed?.templates) ? parsed.templates : [];
		return list
			.filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
			.map(normalize)
			.filter((t) => t.name && t.source);
	} catch {
		return [];
	}
}

async function writeAll(templates: TypstTemplate[]): Promise<void> {
	const path = storePath();
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, JSON.stringify({ templates }));
}

export async function listTemplates({ includeDisabled = false } = {}): Promise<TypstTemplate[]> {
	const templates = await readAll();
	return includeDisabled ? templates : templates.filter((t) => t.enabled);
}

/** Enabled template by id or fuzzy name — what generatePdf resolves. */
export async function resolveTemplate(nameOrId: string): Promise<TypstTemplate | null> {
	const needle = nameOrId.trim().toLowerCase();
	const templates = (await readAll()).filter((t) => t.enabled);
	return (
		templates.find((t) => t.id === nameOrId || t.name.toLowerCase() === needle) ??
		templates.find((t) => t.name.toLowerCase().includes(needle)) ??
		null
	);
}

export type TemplateSaveResult =
	| { ok: true; template: TypstTemplate }
	| { ok: false; reason: 'full' | 'empty' | 'not_found' | 'no_include' };

export async function saveTemplate(input: {
	id?: string;
	name?: string;
	description?: string;
	source?: string;
	enabled?: boolean;
}): Promise<TemplateSaveResult> {
	const templates = await readAll();

	if (input.id) {
		const existing = templates.find((t) => t.id === input.id);
		if (!existing) return { ok: false, reason: 'not_found' };
		const merged = normalize({ ...existing, ...input, updatedAt: new Date().toISOString() });
		if (!merged.name || !merged.source) return { ok: false, reason: 'empty' };
		if (!merged.source.includes(`"${TEMPLATE_CONTENT_FILE}"`)) return { ok: false, reason: 'no_include' };
		templates[templates.indexOf(existing)] = merged;
		await writeAll(templates);
		return { ok: true, template: merged };
	}

	const fresh = normalize({ ...input, id: crypto.randomUUID() });
	if (!fresh.name || !fresh.source) return { ok: false, reason: 'empty' };
	if (!fresh.source.includes(`"${TEMPLATE_CONTENT_FILE}"`)) return { ok: false, reason: 'no_include' };
	if (templates.length >= MAX_TEMPLATES) return { ok: false, reason: 'full' };
	templates.push(fresh);
	await writeAll(templates);
	return { ok: true, template: fresh };
}

export async function removeTemplate(id: string): Promise<boolean> {
	const templates = await readAll();
	const next = templates.filter((t) => t.id !== id);
	if (next.length === templates.length) return false;
	await writeAll(next);
	return true;
}

/** Body used by the console's live preview when testing a template. */
export const SAMPLE_CONTENT = `= Título de exemplo

Este é um parágrafo de demonstração para pré-visualizar o modelo. O corpo real
é escrito pelo assistente em cada relatório.

== Seção

#table(
  columns: 3,
  table.header[*Status*][*Quantidade*][*%*],
  [Ativo], [9.991], [31,5%],
  [Baixado], [21.734], [68,5%],
)

*Total:* 31.725 registros.
`;

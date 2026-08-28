import { mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { env } from '$env/dynamic/private';
import type { NodeCompiler as NodeCompilerType } from '@myriaddreamin/typst-ts-node-compiler';

/**
 * Typst → PDF, in-process (napi) — ported from the tabula integration. Fast
 * enough (tens of ms) that the MODEL authors documents and iterates on
 * compile errors like it iterates on sandbox scripts.
 *
 * What the 0.7.0 compiler is known to give back on failure (measured in
 * tabula): a good `message`, a meaningful `path`, but NO line/column numbers
 * and only the FIRST error — fixing one reveals the next. The tool surfaces
 * the diagnostics verbatim so the model can self-correct.
 *
 * Fonts: typst embeds no text fonts. The app container installs DejaVu +
 * Liberation and points TYPST_FONTS_PATH at them (see Dockerfile).
 */

export interface TypstDiagnostic {
	severity: 'error' | 'warning' | 'note';
	message: string;
	file: string;
}

export class TypstCompileError extends Error {
	readonly diagnostics: TypstDiagnostic[];
	constructor(message: string, diagnostics: TypstDiagnostic[]) {
		super(message);
		this.name = 'TypstCompileError';
		this.diagnostics = diagnostics;
	}
}

let instance: NodeCompilerType | null = null;
let root: string | null = null;

function workspaceRoot(): string {
	if (!root) {
		root = env.TYPST_WORKSPACE || path.join(os.tmpdir(), 'perguntai-typst-root');
		mkdirSync(root, { recursive: true });
	}
	return root;
}

async function compiler(): Promise<NodeCompilerType> {
	if (!instance) {
		// Lazy napi import, same reasoning as the microsandbox SDK: never load
		// native modules at boot for a feature the request may not touch.
		const { NodeCompiler } = await import('@myriaddreamin/typst-ts-node-compiler');
		const fontPaths = (env.TYPST_FONTS_PATH || '')
			.split(path.delimiter)
			.map((p) => p.trim())
			.filter(Boolean);
		instance = NodeCompiler.create({
			workspace: workspaceRoot(),
			...(fontPaths.length ? { fontArgs: [{ fontPaths }] } : {})
		});
	}
	return instance;
}

const SEVERITY: Record<number, TypstDiagnostic['severity']> = { 1: 'error', 2: 'warning' };

function normalize(raw: unknown[]): TypstDiagnostic[] {
	const base = workspaceRoot();
	return raw.map((entry) => {
		const d = (entry ?? {}) as { message?: unknown; path?: unknown; severity?: unknown };
		const rawPath = typeof d.path === 'string' ? d.path : '';
		const rel = rawPath.startsWith(base) ? rawPath.slice(base.length).replace(/^\/+/, '') : rawPath;
		return {
			severity: SEVERITY[typeof d.severity === 'number' ? d.severity : 0] ?? 'note',
			message: typeof d.message === 'string' ? d.message : 'compilation failed',
			file: rel === '__main__.typ' ? 'source' : rel || 'source'
		};
	});
}

/**
 * Compile Typst source to a PDF. `inputs` become `sys.inputs` strings — the
 * clean channel for DATA (the source reads them back with
 * `json(bytes(sys.inputs.at("data", default: "[]")))`), keeping rows out of
 * the markup itself. Throws TypstCompileError with actionable diagnostics.
 */
export async function compileTypstPdf(
	source: string,
	inputs?: Record<string, string>
): Promise<{ pdf: Uint8Array; pages: number }> {
	const c = await compiler();
	const res = c.compile({ mainFileContent: source, ...(inputs ? { inputs } : {}) });
	if (res.hasError()) {
		// hasError() must be read BEFORE takeError(): taking consumes the error.
		const err = res.takeError();
		const diags = normalize((err?.shortDiagnostics as unknown[]) ?? []);
		const first = diags.find((d) => d.severity === 'error') ?? diags[0];
		throw new TypstCompileError(first ? `typst: ${first.message}` : 'typst: compilation failed', diags);
	}
	const doc = res.result!;
	const pdf = c.pdf(doc, { pdfTags: true });
	return { pdf: new Uint8Array(pdf), pages: doc.numOfPages };
}

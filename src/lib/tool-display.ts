import { m } from '$lib/paraglide/messages.js';

export interface ToolDisplay {
	badge: string | null;
	label: string;
	title: string;
	icon: string;
	/** Claude-style context after the label: a file path, a command, a query. */
	detail?: string;
	/** Render the detail in monospace (commands, SQL). */
	mono?: boolean;
}

const BADGES: Record<string, string> = {
	queryDatabase: 'SQL',
	getTableSchema: 'Schema',
	searchDocuments: 'Docs',
	renderChart: 'Chart',
	web_search: 'Web',
	runPython: 'Python'
};

const ICONS: Record<string, string> = {
	queryDatabase: 'database',
	getTableSchema: 'table',
	previewTable: 'table',
	searchDocuments: 'file',
	web_search: 'globe',
	generateExcel: 'download',
	generateDocument: 'download',
	renderChart: 'wrench',
	renderDiagram: 'wrench',
	runPython: 'code',
	sandboxExec: 'terminal',
	sandboxLoadData: 'database',
	sandboxWriteFile: 'file-plus',
	sandboxReadFile: 'eye',
	sandboxEditFile: 'square-pen',
	sandboxPresentFile: 'upload',
	sandboxImportDoc: 'paperclip'
};

/** Localized action labels (Claude-style verbs) for tools that have one. */
const LABELS: Record<string, () => string> = {
	sandboxWriteFile: () => m.tool_write_file(),
	sandboxEditFile: () => m.tool_edit_file(),
	sandboxReadFile: () => m.tool_read_file(),
	sandboxExec: () => m.tool_run_command(),
	sandboxLoadData: () => m.tool_load_data(),
	sandboxPresentFile: () => m.tool_present_file(),
	sandboxImportDoc: () => m.tool_import_doc(),
	queryDatabase: () => m.tool_query_db()
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Per-tool context pulled from the (possibly still streaming) input. */
function toolDetail(raw: string, input: unknown): { detail?: string; mono?: boolean } {
	if (!input || typeof input !== 'object') return {};
	const i = input as Record<string, unknown>;
	switch (raw) {
		case 'sandboxWriteFile':
		case 'sandboxEditFile':
		case 'sandboxReadFile':
			return { detail: str(i.path) };
		case 'sandboxPresentFile':
			return { detail: str(i.filename) ?? str(i.path) };
		case 'sandboxImportDoc':
			return { detail: str(i.name) };
		case 'sandboxExec':
			return { detail: str(i.command), mono: true };
		case 'sandboxLoadData':
			return { detail: str(i.path) ?? 'data.json' };
		case 'queryDatabase': {
			const sql = str(i.sql)?.replace(/\s+/g, ' ').trim();
			return { detail: sql && (sql.length > 80 ? `${sql.slice(0, 80)}…` : sql), mono: true };
		}
		case 'getTableSchema':
			return { detail: str(i.table) };
		default:
			return {};
	}
}

/** Humanize tool names for the chat's tool-activity chips. */
export function toolDisplay(raw: string, input?: unknown): ToolDisplay {
	if (BADGES[raw] || ICONS[raw] || LABELS[raw]) {
		return {
			badge: BADGES[raw] ?? null,
			label: LABELS[raw]?.() ?? raw,
			title: raw,
			icon: ICONS[raw] ?? 'wrench',
			...toolDetail(raw, input)
		};
	}
	// A user-added MCP server's tool: `<serverslug>_<tool_name>`.
	const custom = /^([a-z0-9]+)_(.+)$/.exec(raw);
	if (custom) {
		return {
			badge: custom[1].charAt(0).toUpperCase() + custom[1].slice(1),
			label: custom[2].replaceAll('_', ' '),
			title: raw,
			icon: 'zap'
		};
	}
	return { badge: null, label: raw, title: raw, icon: 'wrench' };
}

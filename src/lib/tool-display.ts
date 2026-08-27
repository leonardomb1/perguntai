export interface ToolDisplay {
	badge: string | null;
	label: string;
	title: string;
	icon: string;
}

const BADGES: Record<string, string> = {
	queryDatabase: 'SQL',
	getTableSchema: 'Schema',
	searchDocuments: 'Docs',
	renderChart: 'Chart',
	web_search: 'Web'
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
	renderDiagram: 'wrench'
};

/** Humanize tool names for the chat's tool-activity chips. */
export function toolDisplay(raw: string): ToolDisplay {
	if (BADGES[raw] || ICONS[raw]) {
		return { badge: BADGES[raw] ?? null, label: raw, title: raw, icon: ICONS[raw] ?? 'wrench' };
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

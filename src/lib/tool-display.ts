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
	web_search: 'Web',
	upsertFlow: 'Flow',
	getFlow: 'Flow'
};

const ICONS: Record<string, string> = {
	queryDatabase: 'database',
	getTableSchema: 'table',
	previewTable: 'table',
	searchDocuments: 'file',
	runPython: 'code',
	web_search: 'globe',
	generateExcel: 'download',
	generateDocument: 'download',
	renderChart: 'wrench',
	renderDiagram: 'wrench',
	upsertFlow: 'zap',
	getFlow: 'zap'
};

/**
 * Humanize tool names. Windmill MCP names encode the script/flow path
 * (`windmill_s-f_data__analytics_tabula__docs` = script f/data_analytics/
 * tabula_docs): `/` became `_` and literal `_` became `__` — decode and show
 * just the script name, with the full path as tooltip.
 */
export function toolDisplay(raw: string): ToolDisplay {
	if (raw.startsWith('windmill_')) {
		let body = raw.slice('windmill_'.length);
		const kind = body.startsWith('s-') ? 'script' : body.startsWith('f-') ? 'flow' : '';
		if (kind) body = body.slice(2);
		const path = body
			.split(/(?<!_)_(?!_)/)
			.map((seg) => seg.replaceAll('__', '_'))
			.join('/');
		return {
			badge: kind ? `Windmill ${kind}` : 'Windmill',
			label: path.split('/').pop() ?? raw,
			title: path,
			icon: 'zap'
		};
	}
	if (raw.startsWith('tabula_')) {
		const name = raw.slice('tabula_'.length).replaceAll('_', ' ');
		return { badge: 'Tabula', label: name, title: raw, icon: 'wrench' };
	}
	return { badge: BADGES[raw] ?? null, label: raw, title: raw, icon: ICONS[raw] ?? 'wrench' };
}

import type { FlowSpec, FlowNode } from '$lib/flow-spec';

/**
 * Render a flow's logical graph as Mermaid `flowchart` source. Flows are
 * read-only and store no coordinates, so an auto-layouted Mermaid diagram is a
 * lighter, clearer representation than a hand-positioned canvas — and it scales
 * to branchy graphs (sqlCheck trip/pass paths become labeled edges). The shared
 * Mermaid component renders, zooms and exports it.
 */

/** Mermaid quoted labels: neutralize quotes/newlines/angle brackets, cap length. */
function esc(text: string): string {
	const clean = text
		.replace(/"/g, "'")
		.replace(/[<>]/g, '')
		.replace(/[\r\n]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return (clean.length > 48 ? clean.slice(0, 47) + '…' : clean) || '—';
}

function nodeLabel(node: FlowNode): string {
	const base = node.label?.trim();
	if (base) return base;
	switch (node.kind) {
		case 'trigger':
			return node.config.mode === 'schedule' ? node.config.cron : 'Manual';
		case 'sqlCheck':
			return `valor ${node.config.op} ${node.config.threshold}`;
		case 'agent':
			return 'Agente';
		case 'notify':
			return 'Notificar';
	}
}

/** Wrap a label in the Mermaid shape for the node's kind. */
function shaped(id: string, node: FlowNode): string {
	const label = `"${esc(nodeLabel(node))}"`;
	switch (node.kind) {
		case 'trigger':
			return `${id}([${label}])`; // stadium
		case 'sqlCheck':
			return `${id}{${label}}`; // decision diamond
		case 'notify':
			return `${id}[[${label}]]`; // subroutine
		case 'agent':
		default:
			return `${id}[${label}]`; // rectangle
	}
}

const EDGE_LABEL: Record<string, string> = { trip: 'sim', pass: 'não' };

export function flowSpecToMermaid(spec: FlowSpec): string {
	if (!spec?.nodes?.length) return 'flowchart TD\n  empty["Fluxo vazio"]';

	// Map opaque node ids to safe mermaid ids (n0, n1, …).
	const idOf = new Map<string, string>();
	spec.nodes.forEach((node, i) => idOf.set(node.id, `n${i}`));

	const lines: string[] = ['flowchart TD'];
	for (const node of spec.nodes) lines.push(`  ${shaped(idOf.get(node.id)!, node)}`);

	for (const edge of spec.edges ?? []) {
		const from = idOf.get(edge.source);
		const to = idOf.get(edge.target);
		if (!from || !to) continue;
		const label = edge.branch ? EDGE_LABEL[edge.branch] ?? edge.branch : '';
		lines.push(label ? `  ${from} -->|${label}| ${to}` : `  ${from} --> ${to}`);
	}

	// Colour by kind, echoing the app's node palette.
	lines.push('  classDef trigger fill:#fbe6d6,stroke:#d9a273,color:#7a4a2c;');
	lines.push('  classDef sqlCheck fill:#e7edf7,stroke:#9db4d8,color:#33466a;');
	lines.push('  classDef agent fill:#ece6f7,stroke:#b7a6e0,color:#4b3a75;');
	lines.push('  classDef notify fill:#e3f3ec,stroke:#9ccbb6,color:#1c6a4c;');
	for (const node of spec.nodes) lines.push(`  class ${idOf.get(node.id)} ${node.kind};`);

	return lines.join('\n');
}

import type { FlowNode, FlowSpec } from '$lib/flow-spec';

/**
 * FlowSpec → Windmill OpenFlow. Every node kind maps to a native primitive:
 *
 *   sqlCheck → script step f/data_analytics/api_endpoint_starrocks (creds via
 *              $var: secret variables) + a branchone gate on the scalar
 *   agent    → inline rawscript that calls back into PerguntAI
 *              (POST /api/flows/agent-step) authenticated by a per-deployment
 *              secret; the agent itself runs app-side with sealed owner creds
 *   notify   → script step f/data_analytics/ntf_send_mail_with_attachment,
 *              emailBody wired from the parent agent's text (or a scalar
 *              template when gated directly by a sqlCheck)
 *   trigger  → not a module; schedule triggers become a Windmill schedule
 *
 * The validator guarantees a TREE (one trigger, single parents, acyclic), so
 * compilation is a straight walk: sequences for chains, branchall for fan-out,
 * branchone for sqlCheck trip/pass.
 */

interface StaticTransform {
	type: 'static';
	value: unknown;
}
interface JsTransform {
	type: 'javascript';
	expr: string;
}
type InputTransform = StaticTransform | JsTransform;
type InputTransforms = Record<string, InputTransform>;

interface OpenFlowModule {
	id: string;
	summary?: string;
	value:
		| { type: 'script'; path: string; input_transforms: InputTransforms }
		| { type: 'rawscript'; language: 'bun'; content: string; input_transforms: InputTransforms }
		| {
				type: 'branchone';
				branches: { summary?: string; expr: string; modules: OpenFlowModule[] }[];
				default: OpenFlowModule[];
		  }
		| { type: 'branchall'; branches: { modules: OpenFlowModule[] }[]; parallel: boolean };
}

export interface CompileContext {
	/** Windmill path prefix owning the deployment, e.g. "u/jdoe/pai_ab12cd34". */
	varPrefix: string;
	/** PerguntAI base URL reachable FROM Windmill workers (agent callbacks). */
	baseUrl: string | null;
	flowId: string;
	owner: string;
	name: string;
}

export const STARROCKS_SCRIPT = 'f/data_analytics/api_endpoint_starrocks';

const stat = (value: unknown): StaticTransform => ({ type: 'static', value });
const js = (expr: string): JsTransform => ({ type: 'javascript', expr });

/** JS expression extracting the first column of the first row of a sqlCheck result. */
const scalarExpr = (checkId: string) =>
	`Number(Object.values(((results.${checkId} ?? {}).data ?? [{}])[0] ?? {})[0] ?? NaN)`;

export function compileFlow(
	spec: FlowSpec,
	ctx: CompileContext
): { value: { modules: OpenFlowModule[] }; schema: object } {
	const byId = new Map(spec.nodes.map((n) => [n.id, n]));
	const trigger = spec.nodes.find((n) => n.kind === 'trigger');
	if (!trigger) throw new Error('Flow has no trigger node');
	if (spec.nodes.some((n) => n.kind === 'agent') && !ctx.baseUrl) {
		throw new Error(
			'This flow has agent steps but PERGUNTAI_BASE_URL is not configured on the server — agent callbacks would have nowhere to go.'
		);
	}

	const childrenOf = (id: string, branch?: 'trip' | 'pass') =>
		spec.edges
			.filter((e) => e.source === id && (branch === undefined || e.branch === branch))
			.map((e) => byId.get(e.target))
			.filter((n): n is FlowNode => Boolean(n));

	const parentOf = (id: string): FlowNode | null => {
		const edge = spec.edges.find((e) => e.target === id);
		return edge ? (byId.get(edge.source) ?? null) : null;
	};

	/** Nearest sqlCheck walking up the (single-parent) ancestry. */
	const ancestorCheck = (id: string): FlowNode | null => {
		let current = parentOf(id);
		while (current) {
			if (current.kind === 'sqlCheck') return current;
			current = parentOf(current.id);
		}
		return null;
	};

	function compileSiblings(nodes: FlowNode[], fanId: string): OpenFlowModule[] {
		if (nodes.length === 0) return [];
		if (nodes.length === 1) return compileNode(nodes[0]);
		return [
			{
				id: `${fanId}_fan`,
				summary: 'Ramificações paralelas',
				value: {
					type: 'branchall',
					parallel: false,
					branches: nodes.map((n) => ({ modules: compileNode(n) }))
				}
			}
		];
	}

	function compileNode(node: FlowNode): OpenFlowModule[] {
		if (node.kind === 'trigger') return compileSiblings(childrenOf(node.id), node.id);

		if (node.kind === 'sqlCheck') {
			const check: OpenFlowModule = {
				id: node.id,
				summary: node.label ?? 'Verificação SQL',
				value: {
					type: 'script',
					path: STARROCKS_SCRIPT,
					input_transforms: {
						query: stat(node.config.query),
						username: stat(`$var:${ctx.varPrefix}_sr_user`),
						password: stat(`$var:${ctx.varPrefix}_sr_pass`),
						page: stat(null),
						pageSize: stat(null),
						autoLimit: stat(null)
					}
				}
			};
			const gate: OpenFlowModule = {
				id: `${node.id}_gate`,
				summary: `Condição: valor ${node.config.op} ${node.config.threshold}`,
				value: {
					type: 'branchone',
					branches: [
						{
							summary: 'trip — condição atendida',
							expr: `${scalarExpr(node.id)} ${node.config.op} ${node.config.threshold}`,
							modules: compileSiblings(childrenOf(node.id, 'trip'), `${node.id}_trip`)
						}
					],
					default: compileSiblings(childrenOf(node.id, 'pass'), `${node.id}_pass`)
				}
			};
			return [check, gate];
		}

		if (node.kind === 'agent') {
			const content = [
				'export async function main(secret: string, context: unknown) {',
				`\tconst res = await fetch(${JSON.stringify(`${ctx.baseUrl}/api/flows/agent-step`)}, {`,
				"\t\tmethod: 'POST',",
				"\t\theaders: { 'Content-Type': 'application/json' },",
				'\t\tbody: JSON.stringify({',
				`\t\t\tflowId: ${JSON.stringify(ctx.flowId)},`,
				`\t\t\towner: ${JSON.stringify(ctx.owner)},`,
				`\t\t\tnodeId: ${JSON.stringify(node.id)},`,
				'\t\t\tsecret,',
				'\t\t\tcontext,',
				'\t\t\t// Root flow job id ties the app-side agent trace to this run.',
				'\t\t\tjobId: process.env.WM_ROOT_FLOW_JOB_ID || process.env.WM_FLOW_JOB_ID || process.env.WM_JOB_ID || null',
				'\t\t})',
				'\t});',
				"\tconst body = await res.json().catch(() => ({} as { text?: string; error?: string }));",
				'\tif (!res.ok || body.error) {',
				'\t\tthrow new Error(body.error ?? `PerguntAI agent step failed (${res.status})`);',
				'\t}',
				"\treturn { text: body.text ?? '' };",
				'}'
			].join('\n');
			const parent = parentOf(node.id);
			const agent: OpenFlowModule = {
				id: node.id,
				summary: node.label ?? 'Agente PerguntAI',
				value: {
					type: 'rawscript',
					language: 'bun',
					content,
					input_transforms: {
						secret: stat(`$var:${ctx.varPrefix}_secret`),
						context: parent && parent.kind !== 'trigger' ? js(`results.${parent.id} ?? null`) : stat(null)
					}
				}
			};
			return [agent, ...compileSiblings(childrenOf(node.id), node.id)];
		}

		// notify
		const parent = parentOf(node.id);
		const check = ancestorCheck(node.id);
		const emailBody: InputTransform =
			parent?.kind === 'agent'
				? js(`results.${parent.id}.text`)
				: check
					? js(
							'`A condição do fluxo ' +
								JSON.stringify(ctx.name).slice(1, -1) +
								' foi atendida — valor verificado: ${' +
								scalarExpr(check.id) +
								'}`'
						)
					: stat(`Fluxo "${ctx.name}" executado.`);
		const notify: OpenFlowModule = {
			id: node.id,
			summary: node.label ?? 'Notificação',
			value: {
				type: 'script',
				path: node.config.scriptPath,
				input_transforms: {
					to: stat(node.config.recipients.join(', ')),
					subject: stat(node.config.subject ?? ctx.name),
					emailBody
				}
			}
		};
		return [notify, ...compileSiblings(childrenOf(node.id), node.id)];
	}

	return {
		value: { modules: compileNode(trigger) },
		schema: {
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'object',
			properties: {},
			required: []
		}
	};
}

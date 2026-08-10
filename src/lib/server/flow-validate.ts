import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { FLOW_OPS, AGENT_TOOL_GRANTS } from '$lib/flow-spec';
import type { FlowSpec, FlowValidationError, FlowNode } from '$lib/flow-spec';
import { isKnownModel } from './models';
import { readOnlyStatement } from './sql-guard';

/**
 * Two-layer validation for AI-composed flows. Layer 1 is the zod schema below
 * (shape + per-kind config, enforced by the tool-call machinery). Layer 2 is
 * validateFlowSemantics — everything JSON Schema cannot express (referential
 * integrity, acyclicity, branch rules, cron/SQL validity). Semantic errors are
 * returned to the model as the tool result, path-addressed so it can repair
 * the graph and retry; the validator's pass is the only success signal.
 */

const nodeId = z
	.string()
	.regex(/^[a-z][a-z0-9_-]{0,31}$/)
	.describe(
		'Stable snake/kebab-case id, e.g. "check_stock". Keep ids UNCHANGED across edits — they anchor versions and diffs.'
	);

const label = z.string().max(60).optional().describe('Short human-readable title for the canvas');

const flowNodeSchema = z.discriminatedUnion('kind', [
	z.object({
		id: nodeId,
		kind: z.literal('trigger'),
		label,
		config: z.discriminatedUnion('mode', [
			z.object({
				mode: z.literal('schedule'),
				cron: z
					.string()
					.describe(
						'Standard 5-field cron "min hour dom month dow" (e.g. "0 8 * * 1-5"), timezone America/Sao_Paulo'
					)
			}),
			z.object({ mode: z.literal('manual') })
		])
	}),
	z.object({
		id: nodeId,
		kind: z.literal('sqlCheck'),
		label,
		config: z.object({
			query: z
				.string()
				.min(1)
				.describe(
					'A single read-only SELECT returning ONE scalar (first column of the first row) to compare against the threshold. Database-qualified table names (e.g. gold.x).'
				),
			op: z.enum(FLOW_OPS).describe('Comparison of the scalar against the threshold; true = condition met (trip)'),
			threshold: z.number()
		})
	}),
	z.object({
		id: nodeId,
		kind: z.literal('agent'),
		label,
		config: z.object({
			prompt: z.string().min(1).max(4000).describe('Instructions for the agent step (what to investigate/produce)'),
			model: z.string().optional().describe('Model id from the app model list; omit for the default'),
			tools: z
				.array(z.enum(AGENT_TOOL_GRANTS))
				.default([])
				.describe('Tool grants: warehouse (SQL), python, windmill, web')
		})
	}),
	z.object({
		id: nodeId,
		kind: z.literal('notify'),
		label,
		config: z.object({
			scriptPath: z.string().min(1).describe('Windmill script path from the notify allowlist'),
			recipients: z.array(z.string().email()).min(1).describe('Recipient e-mail addresses'),
			subject: z.string().max(120).optional()
		})
	})
]);

export const flowSpecSchema = z.object({
	nodes: z.array(flowNodeSchema).min(1).max(15),
	edges: z.array(
		z.object({
			source: nodeId,
			target: nodeId,
			branch: z
				.enum(['trip', 'pass'])
				.optional()
				.describe(
					"REQUIRED on edges leaving a sqlCheck node ('trip' = condition met, 'pass' = not met); FORBIDDEN on edges from any other node kind"
				)
		})
	)
});

/** Windmill scripts a notify node may reference (admin-configurable). */
export function notifyAllowlist(): string[] {
	const fromEnv = (env.FLOW_NOTIFY_SCRIPTS ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return fromEnv.length > 0 ? fromEnv : ['f/data_analytics/ntf_send_mail_with_attachment'];
}

/** Match one cron field (supports *, a, a-b, a,b and /step) within [min,max]. */
function cronFieldValid(field: string, min: number, max: number): boolean {
	if (!field) return false;
	for (const part of field.split(',')) {
		const [rangeRaw, stepRaw, extra] = part.split('/');
		if (extra !== undefined) return false;
		if (stepRaw !== undefined) {
			const step = Number(stepRaw);
			if (!Number.isInteger(step) || step < 1) return false;
		}
		if (rangeRaw === '*') continue;
		let lo: number;
		let hi: number;
		if (rangeRaw.includes('-')) {
			const [a, b] = rangeRaw.split('-');
			lo = Number(a);
			hi = Number(b);
		} else {
			lo = hi = Number(rangeRaw);
		}
		if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi || lo < min || hi > max) return false;
	}
	return true;
}

/** Whether a 5-field cron expression is syntactically valid. */
export function isValidCron(expr: string): boolean {
	const f = expr.trim().split(/\s+/);
	if (f.length !== 5) return false;
	return (
		cronFieldValid(f[0], 0, 59) &&
		cronFieldValid(f[1], 0, 23) &&
		cronFieldValid(f[2], 1, 31) &&
		cronFieldValid(f[3], 1, 12) &&
		cronFieldValid(f[4], 0, 7) // 7 = Sunday alias
	);
}

export function validateFlowSemantics(spec: FlowSpec): FlowValidationError[] {
	const errors: FlowValidationError[] = [];
	const err = (path: string, code: string, message: string) => errors.push({ path, code, message });

	// --- node-level checks + id map ---
	const byId = new Map<string, { node: FlowNode; index: number }>();
	spec.nodes.forEach((node, i) => {
		if (byId.has(node.id)) {
			err(`nodes[${i}].id`, 'duplicate_node_id', `Node id "${node.id}" is used more than once`);
		} else {
			byId.set(node.id, { node, index: i });
		}
		if (node.kind === 'trigger' && node.config.mode === 'schedule' && !isValidCron(node.config.cron)) {
			err(
				`nodes[${i}].config.cron`,
				'invalid_cron',
				`"${node.config.cron}" is not a valid 5-field cron ("min hour dom month dow", e.g. "0 8 * * 1-5")`
			);
		}
		if (node.kind === 'sqlCheck' && readOnlyStatement(node.config.query) === null) {
			err(
				`nodes[${i}].config.query`,
				'query_not_readonly',
				'sqlCheck queries must be a SINGLE read-only statement (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH), no semicolons'
			);
		}
		if (node.kind === 'agent' && node.config.model && !isKnownModel(node.config.model)) {
			err(
				`nodes[${i}].config.model`,
				'unknown_model',
				`"${node.config.model}" is not an available model — omit the field to use the default`
			);
		}
		if (node.kind === 'notify' && !notifyAllowlist().includes(node.config.scriptPath)) {
			err(
				`nodes[${i}].config.scriptPath`,
				'script_not_allowed',
				`"${node.config.scriptPath}" is not on the notify allowlist. Allowed scripts: ${notifyAllowlist().join(', ')}`
			);
		}
	});

	// --- trigger cardinality ---
	const triggers = spec.nodes.filter((n) => n.kind === 'trigger');
	if (triggers.length === 0) {
		err('nodes', 'no_trigger', 'The flow needs exactly one trigger node (kind "trigger"); it has none');
	} else if (triggers.length > 1) {
		err('nodes', 'multiple_triggers', 'The flow must have exactly ONE trigger node; merge or remove the extras');
	}

	// --- edge-level checks ---
	const seenEdges = new Set<string>();
	spec.edges.forEach((edge, i) => {
		const source = byId.get(edge.source);
		const target = byId.get(edge.target);
		if (!source) {
			err(
				`edges[${i}].source`,
				'unknown_edge_endpoint',
				`Edge source "${edge.source}" is not a node id. Existing ids: ${[...byId.keys()].join(', ')}`
			);
		}
		if (!target) {
			err(
				`edges[${i}].target`,
				'unknown_edge_endpoint',
				`Edge target "${edge.target}" is not a node id. Existing ids: ${[...byId.keys()].join(', ')}`
			);
		}
		if (edge.source === edge.target) {
			err(`edges[${i}]`, 'self_loop', `Edge from "${edge.source}" to itself is not allowed`);
		}
		const key = `${edge.source}→${edge.target}:${edge.branch ?? ''}`;
		if (seenEdges.has(key)) {
			err(`edges[${i}]`, 'duplicate_edge', `Duplicate edge ${edge.source} → ${edge.target}`);
		}
		seenEdges.add(key);
		if (target?.node.kind === 'trigger') {
			err(`edges[${i}].target`, 'trigger_has_inputs', 'The trigger node cannot have incoming edges');
		}
		// Branch labels: mandatory leaving a sqlCheck, forbidden elsewhere.
		if (source) {
			if (source.node.kind === 'sqlCheck' && !edge.branch) {
				err(
					`edges[${i}].branch`,
					'missing_branch',
					`Edges leaving sqlCheck "${edge.source}" must set branch: "trip" (condition met) or "pass"`
				);
			}
			if (source.node.kind !== 'sqlCheck' && edge.branch) {
				err(
					`edges[${i}].branch`,
					'invalid_branch',
					`branch labels are only allowed on edges leaving a sqlCheck node ("${edge.source}" is a ${source.node.kind})`
				);
			}
		}
	});

	// Tree constraint: OpenFlow compiles sequences + branches, not arbitrary
	// DAGs — a node with two parents (re-join) has no execution mapping.
	const parentCount = new Map<string, number>();
	for (const edge of spec.edges) {
		parentCount.set(edge.target, (parentCount.get(edge.target) ?? 0) + 1);
	}
	spec.nodes.forEach((node, i) => {
		if ((parentCount.get(node.id) ?? 0) > 1) {
			err(
				`nodes[${i}]`,
				'multiple_parents',
				`Node "${node.id}" has more than one incoming edge — flows must be trees (branches may not re-join); duplicate the step per branch instead`
			);
		}
	});

	// Every sqlCheck needs at least one trip edge (otherwise the gate gates nothing).
	spec.nodes.forEach((node, i) => {
		if (node.kind !== 'sqlCheck') return;
		const hasTrip = spec.edges.some((e) => e.source === node.id && e.branch === 'trip');
		if (!hasTrip) {
			err(
				`nodes[${i}]`,
				'no_trip_edge',
				`sqlCheck "${node.id}" has no outgoing edge with branch "trip" — nothing happens when the condition is met`
			);
		}
	});

	// Structural checks below need valid endpoints — skip when references are broken.
	if (errors.some((e) => e.code === 'unknown_edge_endpoint' || e.code === 'duplicate_node_id')) {
		return errors;
	}

	// --- acyclicity (Kahn's algorithm) ---
	const inDegree = new Map<string, number>(spec.nodes.map((n) => [n.id, 0]));
	const adjacency = new Map<string, string[]>(spec.nodes.map((n) => [n.id, []]));
	for (const edge of spec.edges) {
		inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
		adjacency.get(edge.source)?.push(edge.target);
	}
	const queue = spec.nodes.filter((n) => inDegree.get(n.id) === 0).map((n) => n.id);
	let visited = 0;
	while (queue.length > 0) {
		const id = queue.shift()!;
		visited++;
		for (const next of adjacency.get(id) ?? []) {
			const deg = (inDegree.get(next) ?? 0) - 1;
			inDegree.set(next, deg);
			if (deg === 0) queue.push(next);
		}
	}
	if (visited < spec.nodes.length) {
		const cyclic = [...inDegree.entries()].filter(([, d]) => d > 0).map(([id]) => id);
		err('edges', 'cycle', `The graph contains a cycle involving: ${cyclic.join(', ')} — flows must be acyclic`);
	}

	// --- reachability from the trigger (only meaningful with exactly one) ---
	if (triggers.length === 1 && visited === spec.nodes.length) {
		const reachable = new Set<string>([triggers[0].id]);
		const stack = [triggers[0].id];
		while (stack.length > 0) {
			for (const next of adjacency.get(stack.pop()!) ?? []) {
				if (!reachable.has(next)) {
					reachable.add(next);
					stack.push(next);
				}
			}
		}
		spec.nodes.forEach((node, i) => {
			if (!reachable.has(node.id)) {
				err(
					`nodes[${i}]`,
					'orphan_node',
					`Node "${node.id}" is not reachable from the trigger — connect it or remove it`
				);
			}
		});
	}

	return errors;
}

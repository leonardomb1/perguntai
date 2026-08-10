import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';
import type { FlowTrace, FlowTraceStep } from '$lib/flow-spec';

/**
 * Per-run agent-step traces: what the agent thought and which tools it called
 * while executing a flow's agent node. Written INCREMENTALLY (one entry per
 * agent loop step) so the flows page can poll and show progress while the run
 * is still executing. Keyed by the Windmill ROOT FLOW job id, which is what
 * the runs panel lists — one file per flow, capped to the most recent runs.
 */

const MAX_TRACES = 20;

function tracesPath(username: string, flowId: string): string {
	const safe = username.replace(/[^a-zA-Z0-9._-]/g, '_');
	return join(env.DATA_DIR ?? 'data', 'flows', safe, `traces-${flowId}.json`);
}

async function readTraces(username: string, flowId: string): Promise<FlowTrace[]> {
	try {
		return JSON.parse(await readFile(tracesPath(username, flowId), 'utf8')) as FlowTrace[];
	} catch {
		return [];
	}
}

export async function listTraces(username: string, flowId: string): Promise<FlowTrace[]> {
	return readTraces(username, flowId);
}

// Same serialization discipline as the flows store — concurrent step appends
// from one run (or two runs) must not drop each other's writes.
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(username: string, job: () => Promise<T>): Promise<T> {
	const next = (queues.get(username) ?? Promise.resolve()).then(job, job);
	queues.set(
		username,
		next.catch(() => {})
	);
	return next;
}

async function mutate(
	username: string,
	flowId: string,
	jobId: string,
	nodeId: string,
	fn: (trace: FlowTrace) => void
): Promise<void> {
	await enqueue(username, async () => {
		const traces = await readTraces(username, flowId);
		let trace = traces.find((t) => t.jobId === jobId && t.nodeId === nodeId);
		if (!trace) {
			trace = { jobId, nodeId, startedAt: new Date().toISOString(), steps: [] };
			traces.unshift(trace);
			while (traces.length > MAX_TRACES) traces.pop();
		}
		fn(trace);
		const path = tracesPath(username, flowId);
		await mkdir(join(path, '..'), { recursive: true });
		await writeFile(path, JSON.stringify(traces));
	});
}

export function startTrace(username: string, flowId: string, jobId: string, nodeId: string) {
	return mutate(username, flowId, jobId, nodeId, () => {});
}

export function appendTraceStep(
	username: string,
	flowId: string,
	jobId: string,
	nodeId: string,
	step: FlowTraceStep
) {
	return mutate(username, flowId, jobId, nodeId, (trace) => {
		trace.steps.push(step);
	});
}

export function finishTrace(
	username: string,
	flowId: string,
	jobId: string,
	nodeId: string,
	outcome: { text?: string; error?: string }
) {
	return mutate(username, flowId, jobId, nodeId, (trace) => {
		trace.finishedAt = new Date().toISOString();
		if (outcome.text !== undefined) trace.text = outcome.text;
		if (outcome.error !== undefined) trace.error = outcome.error;
	});
}

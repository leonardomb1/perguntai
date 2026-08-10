/**
 * Shared model for AI-composed flows (client + server, no server-only imports).
 * A flow is a small DAG the chat agent composes via the upsertFlow tool: one
 * trigger feeding sqlCheck gates, agent steps, and notify actions. The LLM
 * emits only the logical graph (stable ids, no coordinates) — the canvas
 * auto-layouts it. Every node kind maps 1:1 to a Windmill OpenFlow primitive
 * so a later phase can compile flows for execution.
 */

export const FLOW_OPS = ['>', '>=', '<', '<=', '==', '!='] as const;
export type FlowOp = (typeof FLOW_OPS)[number];

/**
 * Tools an agent node can be granted. A flow runs AS ITS OWNER, so at
 * execution time these use the owner's credentials (StarRocks; Windmill token
 * from settings; web needs a model that serves server tools).
 */
export const AGENT_TOOL_GRANTS = ['warehouse', 'python', 'windmill', 'web'] as const;
export type AgentToolGrant = (typeof AGENT_TOOL_GRANTS)[number];

export type NodeKind = 'trigger' | 'sqlCheck' | 'agent' | 'notify';

/** 5-field cron ("min hour dom month dow"), interpreted in America/Sao_Paulo. */
export type TriggerConfig = { mode: 'schedule'; cron: string } | { mode: 'manual' };

/** Deterministic detect gate: a read-only SELECT returning one scalar. */
export interface SqlCheckConfig {
	query: string;
	op: FlowOp;
	threshold: number;
}

export interface AgentConfig {
	prompt: string;
	/** Model id from the app's MODELS list; omitted = the default model. */
	model?: string;
	tools: AgentToolGrant[];
}

export interface NotifyConfig {
	/** Windmill script path — must be on the notify allowlist. */
	scriptPath: string;
	recipients: string[];
	subject?: string;
}

export type FlowNode = { id: string; label?: string } & (
	| { kind: 'trigger'; config: TriggerConfig }
	| { kind: 'sqlCheck'; config: SqlCheckConfig }
	| { kind: 'agent'; config: AgentConfig }
	| { kind: 'notify'; config: NotifyConfig }
);

/**
 * Edges leaving a sqlCheck MUST be labeled: 'trip' = the condition was met
 * (anomaly path), 'pass' = it wasn't. Edges from any other kind are unlabeled.
 */
export type FlowBranch = 'trip' | 'pass';

export interface FlowEdge {
	source: string;
	target: string;
	branch?: FlowBranch;
}

export interface FlowSpec {
	nodes: FlowNode[];
	edges: FlowEdge[];
}

/** Path-addressed validation problem returned to the composing agent. */
export interface FlowValidationError {
	/** e.g. "nodes[2].config.cron" or "edges[0].target" */
	path: string;
	code: string;
	message: string;
}

// --- store shapes (shared so the viewer page can type API responses) ---

export interface FlowMeta {
	id: string;
	name: string;
	/** Owner login — flows run as this user; carried so admins can see all flows. */
	owner: string;
	/** Department the flow belongs to; null = orphaned (legacy / unassigned). */
	departmentId: string | null;
	updatedAt: number;
	latestVersion: number;
	/** Reserved for the execution phase; null while flows are drafts. */
	activeVersion: number | null;
}

/** How the requesting user relates to a flow — drives view/run vs edit rights. */
export type FlowAccess = 'admin' | 'owner' | 'department' | 'none';

/** A flow list row as sent to the browser: meta + the caller's access + labels. */
export interface FlowListItem extends FlowMeta {
	access: FlowAccess;
	departmentName: string | null;
	orphaned: boolean;
}

export interface FlowProvenance {
	via: 'chat';
	conversationId: string;
	model: string;
	createdBy: string;
}

export interface FlowVersion {
	version: number;
	createdAt: string;
	spec: FlowSpec;
	provenance: FlowProvenance;
}

/**
 * Live Windmill deployment of one version. `secret` authenticates agent-step
 * callbacks and `sealedCreds` holds the owner's encrypted StarRocks login —
 * both are SERVER-ONLY and stripped from API responses (see publicRecord).
 */
export interface FlowDeployment {
	windmillPath: string;
	deployedVersion: number;
	scheduleEnabled: boolean;
	deployedAt: string;
	secret: string;
	sealedCreds: string;
}

export interface FlowRecord {
	id: string;
	owner: string;
	name: string;
	/** Department the flow belongs to; null = orphaned (legacy / unassigned). */
	departmentId: string | null;
	createdAt: string;
	activeVersion: number | null;
	versions: FlowVersion[];
	deployment?: FlowDeployment;
}

/** FlowRecord as exposed to the browser — deployment secrets removed. */
export type PublicFlowRecord = Omit<FlowRecord, 'deployment'> & {
	deployment?: Omit<FlowDeployment, 'secret' | 'sealedCreds'>;
};

/** One step of an agent node's loop, recorded while a flow run executes. */
export interface FlowTraceStep {
	at: string;
	/** Summarized thinking emitted before this step's action. */
	reasoning?: string;
	/** Tool calls made in this step (input previews, truncated). */
	tools?: { name: string; input: string }[];
}

/** The agent-side story of one flow run's agent node (keyed by Windmill job). */
export interface FlowTrace {
	jobId: string;
	nodeId: string;
	startedAt: string;
	finishedAt?: string;
	steps: FlowTraceStep[];
	/** Final answer handed back to the flow (feeds the notify step). */
	text?: string;
	error?: string;
}

export interface FlowRun {
	id: string;
	/**
	 * running   — a worker is executing it now
	 * queued    — due, waiting for a free worker (normal under load)
	 * scheduled — the pre-created future tick of the cron schedule
	 * success/failed — completed
	 */
	state: 'running' | 'queued' | 'scheduled' | 'success' | 'failed';
	startedAt: string | null;
	scheduledFor: string | null;
	durationMs: number | null;
}

/** Canvas display metadata per node kind (icon name from Icon.svelte). */
export const NODE_DISPLAY: Record<NodeKind, { icon: string; accent: string; bg: string }> = {
	trigger: { icon: 'clock', accent: '#bd5d3a', bg: 'rgba(217, 119, 87, 0.12)' },
	sqlCheck: { icon: 'activity', accent: '#0d8a5f', bg: 'rgba(27, 175, 122, 0.12)' },
	agent: { icon: 'sparkle', accent: '#7c5cd6', bg: 'rgba(124, 92, 214, 0.12)' },
	notify: { icon: 'mail', accent: '#b8860b', bg: 'rgba(212, 160, 23, 0.14)' }
};

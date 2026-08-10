import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import type { ToolSet } from 'ai';
import { env } from '$env/dynamic/private';
import { windmillMcpUrl } from './windmill';

/**
 * Connects the chat to its MCP servers AS THE CALLING USER and returns their
 * tools. Two servers, both optional — when an instance isn't configured or the
 * user has no token, its tools are skipped and the chat keeps working:
 *
 * - Windmill (`windmill_*`): URL built per request from WINDMILL_BASE_URL/
 *   WINDMILL_WORKSPACE plus the user's own Windmill token, so every script or
 *   flow the model runs is scoped by that user's Windmill permissions.
 * - Tabula (`tabula_*`): the documentation platform's MCP at TABULA_MCP_URL,
 *   authenticated with the user's Tabula API token (minted in Tabula under
 *   Settings → API tokens), so doc access mirrors their workspace permissions.
 */
const VALID_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/**
 * Windmill's MCP serves ~83 tools, in two very different groups, and we filter
 * them for two very different reasons.
 *
 * 1. The PER-SCRIPT tail (~46): Windmill exposes every script/flow the user can
 *    access as its own hash-named tool (`S-f_data__analytics_Cach9d53…`). Those
 *    names vary per user, so they bloat the prompt AND make the cached prefix
 *    per-user (killing cross-user reuse). Dropped for EVERYONE — a size
 *    decision, not a permission one, and nothing is lost: they stay reachable
 *    through the generic runScriptByPath / runFlowByPath below.
 *
 * 2. The GENERIC API (~37): stable names, identical for every user, so they sit
 *    in the SHARED prefix and cost nothing to keep. These split by risk —
 *    WINDMILL_READ is always on; WINDMILL_WRITE needs the admin-granted
 *    windmillWrite flag (AccessUser).
 */
const WINDMILL_READ = new Set([
	// Discover + inspect + run. Running is deliberately NOT a write: the script
	// executes under the user's own Windmill permissions either way.
	'listScripts',
	'getScriptByPath',
	'runScriptByPath',
	'runScriptPreviewAndWaitResult',
	'listFlows',
	'getFlowByPath',
	'runFlowByPath',
	'getJob',
	'getJobLogs',
	'queryDocumentation',
	// Variables + schedules: reading a config value or seeing what's scheduled.
	'getVariable',
	'listVariable',
	'listSchedules',
	'getSchedule'
	// Trimmed 2026-07-21: listJobs, listQueue, listWorkers, getResource,
	// listResource, listResourceType — workspace introspection a data-analytics
	// chat essentially never uses. Dropping them shrinks the cached prefix and,
	// more importantly, sharpens the model's tool selection.
]);

/**
 * Mutations to the Windmill workspace itself. Gated: an ungated model here could
 * delete a flow or a secret variable outright, and flow deployment is supposed
 * to go through the draft → activate path on /flows (with the deploy token), not
 * through the chat model calling createFlow directly.
 */
const WINDMILL_WRITE = new Set([
	'createScript',
	'deleteScriptByHash',
	'deleteScriptByPath',
	'createFlow',
	'updateFlow',
	'deleteFlowByPath',
	'createSchedule',
	'updateSchedule',
	'deleteSchedule',
	'createVariable',
	'updateVariable',
	'deleteVariable',
	'createResource',
	'updateResource',
	'deleteResource',
	'createApp',
	'updateApp'
]);

/**
 * Tabula's MCP is small and stable; everything read-only is exposed, and every
 * write flows through Tabula's own permissions and review policy, so the
 * platform — not this chat — decides who may edit and whether publishing needs
 * approval.
 *
 * The draft tools are what make long documents possible at all. Emitting a
 * report as a `content` argument costs its full length in OUTPUT tokens, again on
 * every failed compile and every revision — and a single tool call cannot exceed
 * the model's per-turn output ceiling (see modelMaxOutputTokens), so a long one
 * simply cannot be written that way. Instead: create_draft once, then patch_doc
 * per change, check_doc to compile, render_pdf by docId. Only the diff is ever
 * tokenized, and the finished source never comes back through the model.
 */
const TABULA_TOOLS = new Set([
	// Read
	'search_docs',
	'list_workspaces',
	'list_docs',
	'get_doc',
	'get_published_doc',
	'get_backlinks',
	'list_templates',
	'read_doc',
	'list_drafts',
	// Author and revise
	'create_draft',
	'patch_doc',
	'check_doc',
	'revert_doc',
	'keep_doc',
	'create_doc',
	'update_doc',
	// Output
	'render_pdf',
	'render_pdf_custom',
	'request_publish'
]);

/**
 * Windmill generates tool schemas from script signatures, and untyped
 * parameters come out as `"type": ""` — invalid JSON Schema that Claude's API
 * rejects for the WHOLE request. Strip invalid `type` values in place
 * (schema-less properties are still legal, just unconstrained).
 */
function sanitizeSchema(node: unknown): void {
	if (Array.isArray(node)) {
		for (const item of node) sanitizeSchema(item);
		return;
	}
	if (!node || typeof node !== 'object') return;
	const obj = node as Record<string, unknown>;
	if (typeof obj.type === 'string' && !VALID_TYPES.has(obj.type)) delete obj.type;
	else if (Array.isArray(obj.type)) {
		const kept = obj.type.filter((t) => typeof t === 'string' && VALID_TYPES.has(t));
		if (kept.length) obj.type = kept;
		else delete obj.type;
	}
	for (const value of Object.values(obj)) sanitizeSchema(value);
}

async function connectWindmill(
	token: string | null,
	allowWrites: boolean,
	tools: ToolSet
): Promise<MCPClient | null> {
	const url = token ? windmillMcpUrl(token) : null;
	if (!url) return null;
	try {
		const client = await createMCPClient({ transport: { type: 'http', url } });
		for (const [name, toolDef] of Object.entries(await client.tools())) {
			if (!WINDMILL_READ.has(name) && !(allowWrites && WINDMILL_WRITE.has(name))) continue;
			const raw = (toolDef.inputSchema as { jsonSchema?: unknown } | undefined)?.jsonSchema;
			sanitizeSchema(raw ?? toolDef.inputSchema);
			tools[`windmill_${name}`] = toolDef;
		}
		return client;
	} catch (error) {
		console.warn('Windmill MCP unavailable, skipping:', error);
		return null;
	}
}

async function connectTabula(token: string | null, tools: ToolSet): Promise<MCPClient | null> {
	const url = env.TABULA_MCP_URL?.replace(/\/+$/, '');
	if (!url || !token) return null;
	try {
		const client = await createMCPClient({
			transport: { type: 'http', url, headers: { authorization: `Bearer ${token}` } }
		});
		for (const [name, toolDef] of Object.entries(await client.tools())) {
			if (!TABULA_TOOLS.has(name)) continue;
			tools[`tabula_${name}`] = toolDef;
		}
		return client;
	} catch (error) {
		console.warn('Tabula MCP unavailable, skipping:', error);
		return null;
	}
}

export async function connectMcpTools(
	tokens: { windmill: string | null; tabula: string | null },
	/** From AccessUser.windmillWrite. Off = read-only workspace access. */
	{ allowWrites = false }: { allowWrites?: boolean } = {}
): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
	const tools: ToolSet = {};
	const clients = (
		await Promise.all([
			connectWindmill(tokens.windmill, allowWrites, tools),
			connectTabula(tokens.tabula, tools)
		])
	).filter((c): c is MCPClient => c !== null);

	return {
		tools,
		close: async () => {
			await Promise.all(clients.map((c) => c.close().catch(() => {})));
		}
	};
}

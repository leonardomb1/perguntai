import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import type { ToolSet } from 'ai';
import type { McpServer } from './settings';

/**
 * Connects the chat to the user's own MCP servers and returns their tools.
 * There are NO built-in servers: every integration is a row the user added in
 * Settings → Connectors (URL + optional bearer token) — e.g. GitHub's hosted
 * server at https://api.githubcopilot.com/mcp/readonly with a PAT. The
 * credential is the user's own, so every call carries exactly their
 * permissions; wanting read-only is expressed at the server (GitHub's
 * /readonly URL), because a generic client cannot know which foreign tools
 * mutate.
 */
const VALID_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/**
 * Some servers generate tool schemas from loose signatures, and untyped
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

/**
 * Tools per server. Foreign servers can expose dozens of tools, and every
 * schema rides in the cached prompt prefix. Alphabetical keeps the kept set
 * stable across sessions (cache-friendly); the cut is logged, never silent.
 */
const MAX_CUSTOM_TOOLS = 30;

function slugOf(name: string): string {
	return (
		name
			.toLowerCase()
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '')
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '')
			.slice(0, 24) || 'mcp'
	);
}

async function connectCustom(server: McpServer, tools: ToolSet): Promise<MCPClient | null> {
	try {
		const client = await createMCPClient({
			transport: {
				type: 'http',
				url: server.url,
				...(server.token ? { headers: { authorization: `Bearer ${server.token}` } } : {})
			}
		});
		const prefix = slugOf(server.name);
		const entries = Object.entries(await client.tools()).sort(([a], [b]) => a.localeCompare(b));
		if (entries.length > MAX_CUSTOM_TOOLS) {
			console.warn(
				`MCP "${server.name}": serving first ${MAX_CUSTOM_TOOLS} of ${entries.length} tools (alphabetical)`
			);
		}
		for (const [name, toolDef] of entries.slice(0, MAX_CUSTOM_TOOLS)) {
			const raw = (toolDef.inputSchema as { jsonSchema?: unknown } | undefined)?.jsonSchema;
			sanitizeSchema(raw ?? toolDef.inputSchema);
			tools[`${prefix}_${name}`] = toolDef;
		}
		return client;
	} catch (error) {
		console.warn(`MCP "${server.name}" unavailable, skipping:`, error);
		return null;
	}
}

/**
 * Probe one MCP server: connect, list tools, disconnect. This is what the
 * settings "Testar" button calls, so a misconfigured URL (a REST API, an OAuth
 * audience URI, a typo) fails visibly at save time instead of silently in chat.
 */
export async function testMcpServer(server: {
	url: string;
	token: string | null;
}): Promise<{ ok: true; tools: string[] } | { ok: false; error: string }> {
	let client: MCPClient | null = null;
	try {
		client = await Promise.race([
			createMCPClient({
				transport: {
					type: 'http',
					url: server.url,
					...(server.token ? { headers: { authorization: `Bearer ${server.token}` } } : {})
				}
			}),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('timeout after 10s')), 10_000)
			)
		]);
		const tools = Object.keys(await client.tools()).sort();
		return { ok: true, tools };
	} catch (error) {
		let message = error instanceof Error ? error.message : String(error);
		// undici buries the useful part (ECONNREFUSED, DNS, TLS) in the cause.
		const cause = error instanceof Error ? (error.cause as Error | undefined) : undefined;
		if (cause?.message && !message.includes(cause.message)) message += ` (${cause.message})`;
		return { ok: false, error: message.slice(0, 300) };
	} finally {
		await client?.close().catch(() => {});
	}
}

/** The user's enabled on-demand servers, connected in parallel. */
export async function connectMcpTools(
	custom: McpServer[]
): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
	const tools: ToolSet = {};
	const clients = (await Promise.all(custom.map((server) => connectCustom(server, tools)))).filter(
		(c): c is MCPClient => c !== null
	);

	return {
		tools,
		close: async () => {
			await Promise.all(clients.map((c) => c.close().catch(() => {})));
		}
	};
}

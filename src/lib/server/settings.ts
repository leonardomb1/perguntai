import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

/**
 * Per-user settings: profile (full/preferred name), custom instructions for
 * the agent, and the user's own MCP servers. One JSON file per user under
 * DATA_DIR/settings (same pattern as the conversation store).
 *
 * MCP tokens are long-lived credentials, so they are encrypted at rest
 * (AES-256-GCM, key derived from JWT_SECRET like the JWE bearer tokens) and
 * never echoed back to the client — the API only reports whether one is set.
 */

export interface UserSettings {
	fullName: string;
	displayName: string;
	systemPrompt: string;
	/** On-demand MCP servers the user added, tokens decrypted. */
	mcpServers: McpServer[];
	/** Anthropic server-side web search tool — opt-in, off by default. */
	webSearch: boolean;
	/** Agent-written personal memory — opt-in, off by default (LGPD). */
	memoryEnabled: boolean;
	onboarded: boolean;
}

/**
 * A user-added MCP server: any HTTP MCP endpoint, connected as the user with
 * the bearer token they supplied. Read-only wishes are expressed at the server
 * (e.g. GitHub's hosted MCP has a /readonly URL) — this side only carries the
 * address and credential.
 */
export interface McpServer {
	id: string;
	name: string;
	url: string;
	token: string | null;
	enabled: boolean;
}

/** McpServer as the browser sees it: whether a token exists, never its value. */
export interface PublicMcpServer {
	id: string;
	name: string;
	url: string;
	tokenSet: boolean;
	enabled: boolean;
}

/** Shape safe to send to the browser — the token itself never leaves the server. */
export interface PublicSettings {
	fullName: string;
	displayName: string;
	systemPrompt: string;
	mcpServers: PublicMcpServer[];
	webSearch: boolean;
	memoryEnabled: boolean;
	onboarded: boolean;
}

const DEFAULTS: UserSettings = {
	fullName: '',
	displayName: '',
	systemPrompt: '',
	mcpServers: [],
	webSearch: false,
	memoryEnabled: false,
	onboarded: false
};

const MAX_NAME = 80;
const MAX_PROMPT = 4000;
const MAX_TOKEN = 200;
const MAX_MCP_SERVERS = 5;
const MAX_MCP_NAME = 40;
const MAX_MCP_URL = 300;

function settingsPath(username: string): string {
	const safe = username.replace(/[^a-zA-Z0-9._-]/g, '_');
	return join(env.DATA_DIR ?? 'data', 'settings', `${safe}.json`);
}

function key(): Buffer {
	const value = env.JWT_SECRET;
	if (!value) throw new Error('JWT_SECRET is not set');
	// Distinct derivation from the JWE key so the two can't be swapped.
	return createHash('sha256').update(`settings:${value}`).digest();
}

function encrypt(plain: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key(), iv);
	const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

function decrypt(blob: string): string | null {
	try {
		const raw = Buffer.from(blob, 'base64');
		const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
		decipher.setAuthTag(raw.subarray(12, 28));
		return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
	} catch {
		// Wrong JWT_SECRET or corrupt file — treat as unset rather than erroring.
		return null;
	}
}

interface StoredMcpServer {
	id: string;
	name: string;
	url: string;
	tokenEnc: string | null;
	enabled: boolean;
}

function sanitizeStoredServers(raw: unknown): StoredMcpServer[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
		.slice(0, MAX_MCP_SERVERS)
		.map((x) => ({
			id: typeof x.id === 'string' && x.id ? x.id : crypto.randomUUID(),
			name: typeof x.name === 'string' ? x.name.slice(0, MAX_MCP_NAME) : '',
			url: typeof x.url === 'string' ? x.url.slice(0, MAX_MCP_URL) : '',
			tokenEnc: typeof x.tokenEnc === 'string' ? x.tokenEnc : null,
			enabled: x.enabled !== false
		}))
		.filter((x) => x.name.trim() && /^https?:\/\//.test(x.url));
}

interface StoredSettings extends Omit<UserSettings, 'mcpServers'> {
	mcpServers: StoredMcpServer[];
}

async function readStored(username: string): Promise<StoredSettings> {
	try {
		const parsed = JSON.parse(await readFile(settingsPath(username), 'utf8'));
		return {
			fullName: typeof parsed.fullName === 'string' ? parsed.fullName : '',
			displayName: typeof parsed.displayName === 'string' ? parsed.displayName : '',
			systemPrompt: typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt : '',
			mcpServers: sanitizeStoredServers(parsed.mcpServers),
			webSearch: parsed.webSearch === true,
			memoryEnabled: parsed.memoryEnabled === true,
			onboarded: parsed.onboarded === true
		};
	} catch {
		return { ...DEFAULTS, mcpServers: [] };
	}
}

/** Full settings with MCP tokens decrypted — server-side use only. */
export async function getUserSettings(username: string): Promise<UserSettings> {
	const stored = await readStored(username);
	return {
		fullName: stored.fullName,
		displayName: stored.displayName,
		systemPrompt: stored.systemPrompt,
		mcpServers: stored.mcpServers.map((sv) => ({
			id: sv.id,
			name: sv.name,
			url: sv.url,
			token: sv.tokenEnc ? decrypt(sv.tokenEnc) : null,
			enabled: sv.enabled
		})),
		webSearch: stored.webSearch,
		memoryEnabled: stored.memoryEnabled,
		onboarded: stored.onboarded
	};
}

export async function getPublicSettings(username: string): Promise<PublicSettings> {
	const stored = await readStored(username);
	return {
		fullName: stored.fullName,
		displayName: stored.displayName,
		systemPrompt: stored.systemPrompt,
		mcpServers: publicServers(stored.mcpServers),
		webSearch: stored.webSearch,
		memoryEnabled: stored.memoryEnabled,
		onboarded: stored.onboarded
	};
}

function publicServers(servers: StoredMcpServer[]): PublicMcpServer[] {
	return servers.map((sv) => ({
		id: sv.id,
		name: sv.name,
		url: sv.url,
		tokenSet: sv.tokenEnc !== null,
		enabled: sv.enabled
	}));
}

/** One entry of a submitted server list; token undefined = keep the stored one. */
export interface McpServerPatch {
	id?: string;
	name: string;
	url: string;
	token?: string | null;
	enabled?: boolean;
}

export interface SettingsPatch {
	fullName?: string;
	displayName?: string;
	systemPrompt?: string;
	/** Full replacement list of the user's MCP servers; omitted = unchanged. */
	mcpServers?: McpServerPatch[];
	webSearch?: boolean;
	memoryEnabled?: boolean;
	onboarded?: boolean;
}

export async function saveUserSettings(
	username: string,
	patch: SettingsPatch
): Promise<PublicSettings> {
	const stored = await readStored(username);

	if (typeof patch.fullName === 'string') stored.fullName = patch.fullName.trim().slice(0, MAX_NAME);
	if (typeof patch.displayName === 'string')
		stored.displayName = patch.displayName.trim().slice(0, MAX_NAME);
	if (typeof patch.systemPrompt === 'string')
		stored.systemPrompt = patch.systemPrompt.trim().slice(0, MAX_PROMPT);
	if (Array.isArray(patch.mcpServers)) {
		const previous = new Map(stored.mcpServers.map((sv) => [sv.id, sv]));
		stored.mcpServers = patch.mcpServers.slice(0, MAX_MCP_SERVERS).flatMap((entry) => {
			const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, MAX_MCP_NAME) : '';
			const url = typeof entry.url === 'string' ? entry.url.trim().slice(0, MAX_MCP_URL) : '';
			if (!name || !/^https?:\/\//.test(url)) return [];
			const kept = entry.id ? previous.get(entry.id) : undefined;
			const tokenEnc =
				entry.token === null
					? null
					: typeof entry.token === 'string' && entry.token.trim()
						? encrypt(entry.token.trim().slice(0, MAX_TOKEN))
						: (kept?.tokenEnc ?? null);
			return [
				{
					id: kept?.id ?? crypto.randomUUID(),
					name,
					url,
					tokenEnc,
					enabled: entry.enabled !== false
				}
			];
		});
	}
	if (typeof patch.webSearch === 'boolean') stored.webSearch = patch.webSearch;
	if (typeof patch.memoryEnabled === 'boolean') stored.memoryEnabled = patch.memoryEnabled;
	if (patch.onboarded === true) stored.onboarded = true;

	const path = settingsPath(username);
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, JSON.stringify(stored));

	return {
		fullName: stored.fullName,
		displayName: stored.displayName,
		systemPrompt: stored.systemPrompt,
		mcpServers: publicServers(stored.mcpServers),
		webSearch: stored.webSearch,
		memoryEnabled: stored.memoryEnabled,
		onboarded: stored.onboarded
	};
}

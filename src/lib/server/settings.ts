import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

/**
 * Per-user settings: profile (full/preferred name), custom instructions for
 * the agent, and the user's own Windmill token. One JSON file per user under
 * DATA_DIR/settings (same pattern as the conversation store).
 *
 * The Windmill token is a long-lived credential, so it is encrypted at rest
 * (AES-256-GCM, key derived from JWT_SECRET like the JWE bearer tokens) and
 * never echoed back to the client — the API only reports whether one is set.
 */

export interface UserSettings {
	fullName: string;
	displayName: string;
	systemPrompt: string;
	/** Decrypted Windmill user token, or null when the user hasn't set one. */
	windmillToken: string | null;
	/**
	 * Decrypted full-access Windmill token minted for flow deployment (the
	 * scoped token above cannot create flows/schedules/variables). Null for
	 * users who saved their token before this existed — they re-save once.
	 */
	windmillDeployToken: string | null;
	/** Decrypted Tabula API token for the docs MCP, or null when unset. */
	tabulaToken: string | null;
	/** Anthropic server-side web search tool — opt-in, off by default. */
	webSearch: boolean;
	/** Agent-written personal memory — opt-in, off by default (LGPD). */
	memoryEnabled: boolean;
	onboarded: boolean;
}

/** Shape safe to send to the browser — the token itself never leaves the server. */
export interface PublicSettings {
	fullName: string;
	displayName: string;
	systemPrompt: string;
	windmillTokenSet: boolean;
	tabulaTokenSet: boolean;
	webSearch: boolean;
	memoryEnabled: boolean;
	onboarded: boolean;
}

const DEFAULTS: UserSettings = {
	fullName: '',
	displayName: '',
	systemPrompt: '',
	windmillToken: null,
	windmillDeployToken: null,
	tabulaToken: null,
	webSearch: false,
	memoryEnabled: false,
	onboarded: false
};

const MAX_NAME = 80;
const MAX_PROMPT = 4000;
const MAX_TOKEN = 200;

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

interface StoredSettings
	extends Omit<UserSettings, 'windmillToken' | 'windmillDeployToken' | 'tabulaToken'> {
	windmillTokenEnc: string | null;
	windmillDeployTokenEnc: string | null;
	tabulaTokenEnc: string | null;
}

async function readStored(username: string): Promise<StoredSettings> {
	try {
		const parsed = JSON.parse(await readFile(settingsPath(username), 'utf8'));
		return {
			fullName: typeof parsed.fullName === 'string' ? parsed.fullName : '',
			displayName: typeof parsed.displayName === 'string' ? parsed.displayName : '',
			systemPrompt: typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt : '',
			windmillTokenEnc: typeof parsed.windmillTokenEnc === 'string' ? parsed.windmillTokenEnc : null,
			windmillDeployTokenEnc:
				typeof parsed.windmillDeployTokenEnc === 'string' ? parsed.windmillDeployTokenEnc : null,
			tabulaTokenEnc: typeof parsed.tabulaTokenEnc === 'string' ? parsed.tabulaTokenEnc : null,
			webSearch: parsed.webSearch === true,
			memoryEnabled: parsed.memoryEnabled === true,
			onboarded: parsed.onboarded === true
		};
	} catch {
		const { windmillToken: _, windmillDeployToken: __, tabulaToken: ___, ...rest } = DEFAULTS;
		return { ...rest, windmillTokenEnc: null, windmillDeployTokenEnc: null, tabulaTokenEnc: null };
	}
}

/** Full settings with the Windmill tokens decrypted — server-side use only. */
export async function getUserSettings(username: string): Promise<UserSettings> {
	const stored = await readStored(username);
	return {
		fullName: stored.fullName,
		displayName: stored.displayName,
		systemPrompt: stored.systemPrompt,
		windmillToken: stored.windmillTokenEnc ? decrypt(stored.windmillTokenEnc) : null,
		windmillDeployToken: stored.windmillDeployTokenEnc
			? decrypt(stored.windmillDeployTokenEnc)
			: null,
		tabulaToken: stored.tabulaTokenEnc ? decrypt(stored.tabulaTokenEnc) : null,
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
		windmillTokenSet: stored.windmillTokenEnc !== null,
		tabulaTokenSet: stored.tabulaTokenEnc !== null,
		webSearch: stored.webSearch,
		memoryEnabled: stored.memoryEnabled,
		onboarded: stored.onboarded
	};
}

export interface SettingsPatch {
	fullName?: string;
	displayName?: string;
	systemPrompt?: string;
	/** New token to store; `null` clears it; omitted leaves it unchanged. */
	windmillToken?: string | null;
	/** Deployment token minted alongside windmillToken; cleared together. */
	windmillDeployToken?: string | null;
	/** Tabula docs-MCP token; `null` clears, omitted leaves unchanged. */
	tabulaToken?: string | null;
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
	if (patch.windmillToken === null) stored.windmillTokenEnc = null;
	else if (typeof patch.windmillToken === 'string' && patch.windmillToken.trim()) {
		stored.windmillTokenEnc = encrypt(patch.windmillToken.trim().slice(0, MAX_TOKEN));
	}
	if (patch.windmillDeployToken === null) stored.windmillDeployTokenEnc = null;
	else if (typeof patch.windmillDeployToken === 'string' && patch.windmillDeployToken.trim()) {
		stored.windmillDeployTokenEnc = encrypt(patch.windmillDeployToken.trim().slice(0, MAX_TOKEN));
	}
	if (patch.tabulaToken === null) stored.tabulaTokenEnc = null;
	else if (typeof patch.tabulaToken === 'string' && patch.tabulaToken.trim()) {
		stored.tabulaTokenEnc = encrypt(patch.tabulaToken.trim().slice(0, MAX_TOKEN));
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
		windmillTokenSet: stored.windmillTokenEnc !== null,
		tabulaTokenSet: stored.tabulaTokenEnc !== null,
		webSearch: stored.webSearch,
		memoryEnabled: stored.memoryEnabled,
		onboarded: stored.onboarded
	};
}

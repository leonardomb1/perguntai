import { getToken } from '$lib/session';

/**
 * Client for /api/settings. MCP tokens are write-only from the browser's
 * point of view: PUT sends them, GET only reports whether one is set.
 */

export interface PublicMcpServer {
	id: string;
	name: string;
	url: string;
	tokenSet: boolean;
	enabled: boolean;
}

export interface PublicSettings {
	fullName: string;
	displayName: string;
	systemPrompt: string;
	mcpServers: PublicMcpServer[];
	webSearch: boolean;
	/** Whether the deployment's provider workspace supports server-side web search. */
	webSearchAvailable?: boolean;
	memoryEnabled: boolean;
	onboarded: boolean;
	role: 'admin' | 'builder' | 'user';
	/** App admin (role admin or env admin). Resolved live server-side. */
	isAdmin: boolean;
	/** Server/bootstrap admin (ADMIN_USERS env — the "SERVIDOR" badge). */
	isPlatformAdmin: boolean;
}

export interface SettingsPatch {
	fullName?: string;
	displayName?: string;
	systemPrompt?: string;
	/** Full replacement list; per-entry token: string sets, null clears, undefined keeps. */
	mcpServers?: Array<{ id?: string; name: string; url: string; token?: string | null; enabled: boolean }>;
	webSearch?: boolean;
	memoryEnabled?: boolean;
	onboarded?: boolean;
}

function headers(): Record<string, string> {
	return { Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': 'application/json' };
}

export async function fetchSettings(): Promise<PublicSettings | null> {
	try {
		const res = await fetch('/api/settings', { headers: headers() });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function saveSettings(patch: SettingsPatch): Promise<PublicSettings | null> {
	try {
		const res = await fetch('/api/settings', {
			method: 'PUT',
			headers: headers(),
			body: JSON.stringify(patch)
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

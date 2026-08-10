import { getToken } from '$lib/session';

/**
 * Client for /api/settings. The Windmill token is write-only from the
 * browser's point of view: PUT sends it, GET only reports `windmillTokenSet`.
 */

export interface PublicSettings {
	fullName: string;
	displayName: string;
	systemPrompt: string;
	windmillTokenSet: boolean;
	tabulaTokenSet: boolean;
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
	windmillToken?: string | null;
	tabulaToken?: string | null;
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

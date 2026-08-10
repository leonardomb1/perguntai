import { browser } from '$app/environment';

const TOKEN_KEY = 'perguntai_token';
const NAME_KEY = 'perguntai_display_name';

export function getToken(): string | null {
	return browser ? localStorage.getItem(TOKEN_KEY) : null;
}

export function getDisplayName(): string | null {
	return browser ? localStorage.getItem(NAME_KEY) : null;
}

export function saveSession(token: string, displayName: string | null) {
	localStorage.setItem(TOKEN_KEY, token);
	if (displayName) localStorage.setItem(NAME_KEY, displayName);
}

export function clearSession() {
	localStorage.removeItem(TOKEN_KEY);
	localStorage.removeItem(NAME_KEY);
}

/**
 * True when a token is stored. The token is an encrypted JWT, so its expiry
 * can't be read client-side — an expired token simply gets a 401 from the API
 * and the app redirects back to /login.
 */
export function hasSession(): boolean {
	return getToken() !== null;
}

import { browser } from '$app/environment';
import { goto } from '$app/navigation';

const TOKEN_KEY = 'perguntai_token';
const NAME_KEY = 'perguntai_display_name';
const USERNAME_KEY = 'perguntai_username';

export function getToken(): string | null {
	return browser ? localStorage.getItem(TOKEN_KEY) : null;
}

export function getDisplayName(): string | null {
	return browser ? localStorage.getItem(NAME_KEY) : null;
}

/** Login username (canonical id) — what avatars and admin views key on. */
export function getUsername(): string | null {
	return browser ? localStorage.getItem(USERNAME_KEY) : null;
}

export function saveUsername(username: string) {
	if (browser) localStorage.setItem(USERNAME_KEY, username);
}

export function saveSession(token: string, displayName: string | null, username?: string | null) {
	localStorage.setItem(TOKEN_KEY, token);
	if (displayName) localStorage.setItem(NAME_KEY, displayName);
	if (username) localStorage.setItem(USERNAME_KEY, username);
}

export function clearSession() {
	localStorage.removeItem(TOKEN_KEY);
	localStorage.removeItem(NAME_KEY);
	localStorage.removeItem(USERNAME_KEY);
}

/**
 * True when a token is stored. The token is an encrypted JWT, so its expiry
 * can't be read client-side — expiry is caught by authFetch (any 401) and by
 * the /api/me probe on app load.
 */
export function hasSession(): boolean {
	return getToken() !== null;
}

/**
 * The fetch every authenticated call goes through: attaches the bearer token,
 * stores the slid replacement the server may return (sliding sessions), and on
 * a 401 clears the session and sends the user to /login — the one behavior an
 * expired token must always produce, no matter which call hit it first.
 */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('Authorization', `Bearer ${getToken() ?? ''}`);
	const res = await fetch(input, { ...init, headers });
	const slid = res.headers.get('x-session-token');
	if (slid) saveSession(slid, getDisplayName());
	if (res.status === 401) {
		clearSession();
		void goto('/login?expired');
	}
	return res;
}

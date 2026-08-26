import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { authenticateRequest, type AuthUser } from '$lib/server/auth';
import { resolveRole } from '$lib/server/access';
import { getPublicSettings } from '$lib/server/settings';
import type { RequestHandler } from './$types';

/**
 * Connector governance: which MCP servers each user has wired into their
 * agent, plus whether the built-in connector tokens are set. Read-only —
 * connectors are personal settings; the audit log records their changes.
 * Only public shapes cross this boundary (names/URLs/enabled, never tokens).
 */
async function requireAdmin(request: Request): Promise<AuthUser | Response> {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	if ((await resolveRole(user.username, user.profile)) !== 'admin')
		return json({ error: 'Forbidden' }, { status: 403 });
	return user;
}

export const GET: RequestHandler = async ({ request }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;

	let files: string[] = [];
	try {
		files = (await readdir(join(env.DATA_DIR ?? 'data', 'settings'))).filter((f) =>
			f.endsWith('.json')
		);
	} catch {
		// No settings yet.
	}

	const users = [];
	for (const file of files) {
		const username = file.replace(/\.json$/, '');
		const s = await getPublicSettings(username);
		if (!s.windmillTokenSet && !s.tabulaTokenSet && s.mcpServers.length === 0) continue;
		users.push({
			username,
			windmillTokenSet: s.windmillTokenSet,
			tabulaTokenSet: s.tabulaTokenSet,
			mcpServers: s.mcpServers.map((sv) => ({
				name: sv.name,
				url: sv.url,
				enabled: sv.enabled,
				tokenSet: sv.tokenSet
			}))
		});
	}
	users.sort((a, b) => a.username.localeCompare(b.username));
	return json({ users });
};

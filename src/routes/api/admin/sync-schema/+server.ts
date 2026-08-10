import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { authenticateRequest } from '$lib/server/auth';
import { resolveRole } from '$lib/server/access';
import { runSchemaSync } from '$lib/server/schema-sync';
import type { RequestHandler } from './$types';

/**
 * Regenerate the warehouse catalog (schema.json). Intended to be triggered by a
 * Windmill cron: POST here with `Authorization: Bearer <SCHEMA_SYNC_TOKEN>`.
 * Also allowed for a signed-in admin (so it can be run manually). The sync uses
 * the STARROCKS_SYNC_* service account server-side — no end-user credentials.
 */
export const POST: RequestHandler = async ({ request }) => {
	const token = env.SCHEMA_SYNC_TOKEN;
	const authorized =
		(!!token && request.headers.get('authorization') === `Bearer ${token}`) ||
		(await (async () => {
			const user = await authenticateRequest(request);
			return !!user && (await resolveRole(user.username)) === 'admin';
		})());
	if (!authorized) return json({ error: 'Forbidden' }, { status: 403 });

	try {
		const result = await runSchemaSync();
		return json({ ok: true, ...result });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'sync failed';
		console.error('schema sync failed:', message);
		return json({ ok: false, error: message.slice(0, 300) }, { status: 500 });
	}
};

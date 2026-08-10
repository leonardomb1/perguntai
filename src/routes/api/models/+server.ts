import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import { resolveAllowedModels, resolveRole } from '$lib/server/access';
import { clientModels, DEFAULT_MODEL } from '$lib/server/models';
import type { RequestHandler } from './$types';

/**
 * The models the authenticated user may pick, for the chat model selector.
 * Admins additionally get the FULL deployment catalog (`all`) — the admin
 * panel's per-user grant UI needs it, and the catalog is env-defined
 * server-side (MODELS_EXTRA), not shipped in the client bundle.
 */
export const GET: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	const catalog = clientModels();
	const ids = await resolveAllowedModels(user.username);
	const isAdmin = user.isPlatformAdmin || (await resolveRole(user.username)) === 'admin';
	return json({
		models: catalog.filter((mo) => ids.includes(mo.id)),
		default: DEFAULT_MODEL,
		...(isAdmin ? { all: catalog } : {})
	});
};

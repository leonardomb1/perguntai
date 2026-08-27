import { getCapabilities } from '$lib/server/access';
import { resolveEmbedAccess } from '$lib/server/embed';
import type { PageServerLoad } from './$types';

/** Public page — no auth. The chat endpoint re-checks everything server-side. */
export const load: PageServerLoad = async ({ url }) => {
	const key = url.searchParams.get('key');
	if (!(await getCapabilities()).embedChat) return { enabled: false, maxMessages: 0, key };
	const access = await resolveEmbedAccess(key);
	return { enabled: Boolean(access), maxMessages: access?.maxMessages ?? 0, key };
};

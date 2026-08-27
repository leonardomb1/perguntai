import { getCapabilities } from '$lib/server/access';
import { embedConfig } from '$lib/server/embed';
import type { PageServerLoad } from './$types';

/** Public page — no auth. The chat endpoint re-checks everything server-side. */
export const load: PageServerLoad = async () => {
	const config = embedConfig();
	return {
		enabled: (await getCapabilities()).embedChat && config.configured,
		maxMessages: config.maxMessages
	};
};

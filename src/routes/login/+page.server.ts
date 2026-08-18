import { authMethods } from '$lib/server/auth';
import type { PageServerLoad } from './$types';

/** Which sign-in options to draw; both come from env, so this is all the page needs. */
export const load: PageServerLoad = () => ({ methods: authMethods() });

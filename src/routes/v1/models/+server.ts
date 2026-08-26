import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import { resolveAllowedModels } from '$lib/server/access';
import type { RequestHandler } from './$types';

/**
 * OpenAI-compatible model listing (`GET /v1/models`) — the shape LangChain,
 * LiteLLM, Open WebUI and friends probe on connect. Lists the models THIS
 * caller may use, per their live allow-list.
 */
export const GET: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) {
		return json(
			{ error: { message: 'Invalid API key', type: 'invalid_request_error' } },
			{ status: 401 }
		);
	}
	const ids = await resolveAllowedModels(user.username, user.profile);
	return json({
		object: 'list',
		data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'perguntai' }))
	});
};

import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import { hasRun, liveStreamKey, replayStream, stopRun } from '$lib/server/live-streams';
import type { RequestHandler } from './$types';

/**
 * Reconnect endpoint for the AI SDK's resumeStream() protocol. GET replays the
 * buffered UI stream of this conversation's live (or just-finished) run and
 * follows the live tail; 204 means nothing to resume. HEAD answers the same
 * 200/204 without a body, so the client can learn whether a replay exists
 * before it drops its own copy of the last turn (the replay rebuilds that turn
 * from its start — appended onto an existing copy it would duplicate it).
 * DELETE aborts the run server-side — the client's stop button calls it, since
 * a dropped socket no longer cancels anything.
 */
export const HEAD: RequestHandler = async ({ request, params }) => {
	const user = await authenticateRequest(request);
	if (!user) return new Response(null, { status: 401 });
	return new Response(null, { status: hasRun(liveStreamKey(user.username, params.id)) ? 200 : 204 });
};

export const GET: RequestHandler = async ({ request, params }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	const stream = replayStream(liveStreamKey(user.username, params.id));
	if (!stream) return new Response(null, { status: 204 });

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-store',
			Connection: 'keep-alive',
			'x-vercel-ai-ui-message-stream': 'v1'
		}
	});
};

export const DELETE: RequestHandler = async ({ request, params }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	return json({ stopped: stopRun(liveStreamKey(user.username, params.id)) });
};

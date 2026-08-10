/**
 * SSE keepalive for the chat streams.
 *
 * On CPU inference the model can spend 60–90s processing the prompt before the
 * first token, and the UI stream goes silent after its opening events. Mobile
 * networks and phone Wi-Fi power management kill TCP connections that stay
 * quiet for ~30–60s, so the client sees "network error" while the server
 * finishes the run just fine. Injecting an SSE comment line (": keepalive")
 * whenever the stream has been silent keeps the connection alive end to end —
 * comment lines are ignored by every SSE parser, including the AI SDK's.
 */
export function withHeartbeat(response: Response, intervalMs = 15_000): Response {
	const body = response.body;
	if (!body) return response;

	const encoder = new TextEncoder();
	let lastWrite = Date.now();
	let timer: ReturnType<typeof setInterval> | null = null;
	const stop = () => {
		if (timer) clearInterval(timer);
		timer = null;
	};

	const stream = new TransformStream<Uint8Array, Uint8Array>({
		start(controller) {
			timer = setInterval(() => {
				if (Date.now() - lastWrite < intervalMs) return;
				try {
					controller.enqueue(encoder.encode(': keepalive\n\n'));
					lastWrite = Date.now();
				} catch {
					// Stream already closed (client gone) — stop pinging.
					stop();
				}
			}, intervalMs);
		},
		transform(chunk, controller) {
			lastWrite = Date.now();
			controller.enqueue(chunk);
		},
		flush() {
			stop();
		}
	});

	return new Response(body.pipeThrough(stream), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});
}

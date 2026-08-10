import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import { readExport, EXPORT_TYPES } from '$lib/server/exports';
import type { RequestHandler } from './$types';

/** Authenticated download of a generated file (.xlsx report, .md/.txt/.csv document). */
export const GET: RequestHandler = async ({ request, url }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	const id = url.searchParams.get('id') ?? '';
	const hit = await readExport(user.username, id);
	if (!hit) return json({ error: 'Export not found or expired' }, { status: 404 });

	const name = (url.searchParams.get('name') ?? `export.${hit.ext}`)
		.replace(/[^\w.\- ()]/g, '_')
		.slice(0, 100);

	return new Response(new Uint8Array(hit.buffer), {
		headers: {
			'Content-Type': EXPORT_TYPES[hit.ext],
			'Content-Disposition': `attachment; filename="${name.endsWith(`.${hit.ext}`) ? name : `${name}.${hit.ext}`}"`,
			'Content-Length': String(hit.buffer.length)
		}
	});
};

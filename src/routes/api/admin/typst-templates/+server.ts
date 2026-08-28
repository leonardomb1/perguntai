import { json } from '@sveltejs/kit';
import { authenticateRequest, type AuthUser } from '$lib/server/auth';
import { resolveRole } from '$lib/server/access';
import {
	listTemplates,
	removeTemplate,
	saveTemplate,
	SAMPLE_CONTENT,
	TEMPLATE_CONTENT_FILE
} from '$lib/server/typstTemplates';
import { compileTypstSvg, TypstCompileError } from '$lib/server/typst';
import { logAudit, requestMeta } from '$lib/server/audit';
import type { RequestHandler } from './$types';

/** PDF template management (console → Modelos PDF). Admin-only. */
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
	return json({ templates: await listTemplates({ includeDisabled: true }) });
};

// Create (no id) or update (id given). `preview: true` compiles WITHOUT saving.
export const POST: RequestHandler = async ({ request }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;
	const body = await request.json().catch(() => ({}));

	if (body.preview === true) {
		const source = typeof body.source === 'string' ? body.source : '';
		if (!source.trim()) return json({ error: 'source is empty' }, { status: 400 });
		try {
			const { svg, pages } = await compileTypstSvg(source, undefined, {
				[TEMPLATE_CONTENT_FILE]: SAMPLE_CONTENT
			});
			return json({ svg, pages });
		} catch (error) {
			if (error instanceof TypstCompileError) {
				return json({ error: error.message, diagnostics: error.diagnostics }, { status: 422 });
			}
			return json(
				{ error: error instanceof Error ? error.message : 'compile failed' },
				{ status: 500 }
			);
		}
	}

	const result = await saveTemplate({
		id: typeof body.id === 'string' ? body.id : undefined,
		name: typeof body.name === 'string' ? body.name : undefined,
		description: typeof body.description === 'string' ? body.description : undefined,
		source: typeof body.source === 'string' ? body.source : undefined,
		enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined
	});
	if (!result.ok) return json({ error: result.reason }, { status: 400 });
	logAudit({
		actor: admin.username,
		via: 'session',
		...requestMeta(request),
		category: 'admin',
		action: body.id ? 'pdftemplate.update' : 'pdftemplate.create',
		target: result.template.name,
		status: 'ok'
	});
	return json({ template: result.template });
};

export const DELETE: RequestHandler = async ({ request, url }) => {
	const admin = await requireAdmin(request);
	if (admin instanceof Response) return admin;
	const id = url.searchParams.get('id');
	if (!id) return json({ error: 'Missing id' }, { status: 400 });
	const ok = await removeTemplate(id);
	if (!ok) return json({ error: 'Not found' }, { status: 404 });
	logAudit({
		actor: admin.username,
		via: 'session',
		...requestMeta(request),
		category: 'admin',
		action: 'pdftemplate.delete',
		target: id,
		status: 'ok'
	});
	return json({ ok: true });
};

import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import { getDepartments, resolveRole } from '$lib/server/access';
import {
	addSharedDoc,
	addSharedTabularDoc,
	deptScope,
	listSharedDocs,
	orgScope,
	removeSharedDoc
} from '$lib/server/rag';
import { parseWorkbook } from '$lib/server/workbook';
import { fileToText, PDF_TYPE, SHARED_TEXT_TYPES } from '$lib/server/extract';
import type { RequestHandler } from './$types';

/**
 * Admin-curated shared document libraries — organization-wide (`scope=org`) or
 * per department (`scope=<departmentId>`). Text and PDF only in v1. Every doc
 * uploaded here is retrievable by everyone in that scope via the assistant.
 */

const MAX_TEXT_SIZE = 16 * 1024 * 1024; // 16 MB — large manuals are the point
const MAX_PDF_SIZE = 12 * 1024 * 1024; // 12 MB
const MAX_TABLE_SIZE = 8 * 1024 * 1024; // 8 MB
const TABLE_TYPES = /\.(csv|xlsx|xls)$/i;

async function requireAdmin(request: Request) {
	const user = await authenticateRequest(request);
	if (!user) return null;
	return (await resolveRole(user.username)) === 'admin' ? user : null;
}

/** Map a scope param ('org' | departmentId) to a store scope, or null if invalid. */
async function resolveScope(scope: string | null): Promise<string | null> {
	if (!scope) return null;
	if (scope === 'org') return orgScope;
	return (await getDepartments()).some((d) => d.id === scope) ? deptScope(scope) : null;
}

export const GET: RequestHandler = async ({ request, url }) => {
	if (!(await requireAdmin(request))) return json({ error: 'Forbidden' }, { status: 403 });
	const scope = await resolveScope(url.searchParams.get('scope'));
	if (!scope) return json({ error: 'unknown_scope' }, { status: 400 });
	return json({ documents: await listSharedDocs(scope) });
};

export const POST: RequestHandler = async ({ request }) => {
	if (!(await requireAdmin(request))) return json({ error: 'Forbidden' }, { status: 403 });

	const form = await request.formData();
	const file = form.get('file');
	const scope = await resolveScope(form.get('scope') as string | null);
	const description = typeof form.get('description') === 'string' ? (form.get('description') as string) : undefined;
	if (!(file instanceof File)) return json({ error: 'No file provided' }, { status: 400 });
	if (!scope) return json({ error: 'unknown_scope' }, { status: 400 });

	const isPdf = PDF_TYPE.test(file.name);
	const isTable = TABLE_TYPES.test(file.name);
	if (!isPdf && !isTable && !SHARED_TEXT_TYPES.test(file.name)) {
		return json(
			{ error: 'Supported: text (.txt .md .json .sql .log), spreadsheets (.csv .xlsx .xls) and PDF (.pdf)' },
			{ status: 415 }
		);
	}
	const limit = isPdf ? MAX_PDF_SIZE : isTable ? MAX_TABLE_SIZE : MAX_TEXT_SIZE;
	if (file.size > limit) {
		return json({ error: `File exceeds the ${Math.round(limit / 1024 / 1024)} MB limit` }, { status: 413 });
	}

	try {
		if (isTable) {
			const sheets = parseWorkbook(Buffer.from(await file.arrayBuffer()));
			if (sheets.length === 0) return json({ error: 'No readable sheets' }, { status: 400 });
			const doc = await addSharedTabularDoc(scope, file.name, sheets, description);
			return json({ id: doc.id, name: doc.name, summary: doc.summary }, { status: 201 });
		}
		const text = await fileToText(file);
		if (!text.trim()) {
			return json(
				{ error: isPdf ? 'No extractable text — is this a scanned/image PDF?' : 'Empty file' },
				{ status: 400 }
			);
		}
		const doc = await addSharedDoc(scope, file.name, text, description);
		return json({ id: doc.id, name: doc.name, summary: doc.summary }, { status: 201 });
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : 'Upload failed' }, { status: 400 });
	}
};

export const DELETE: RequestHandler = async ({ request, url }) => {
	if (!(await requireAdmin(request))) return json({ error: 'Forbidden' }, { status: 403 });
	const scope = await resolveScope(url.searchParams.get('scope'));
	const id = url.searchParams.get('id');
	if (!scope || !id) return json({ error: 'scope and id required' }, { status: 400 });
	await removeSharedDoc(scope, id);
	return json({ ok: true });
};

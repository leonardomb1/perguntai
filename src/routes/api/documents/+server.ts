import { json } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth';
import { addDoc, addTabularDoc, listDocs, removeDoc } from '$lib/server/rag';
import { parseWorkbook } from '$lib/server/workbook';
import type { RequestHandler } from './$types';

// Large manuals are the point of retrieval — the ceiling is the request body
// (BODY_SIZE_LIMIT), not the reader. Chunking keeps memory flat either way.
const MAX_TEXT_SIZE = 16 * 1024 * 1024; // 16 MB
const MAX_TABLE_SIZE = 8 * 1024 * 1024; // 8 MB — xlsx compresses heavily
const TEXT_TYPES = /\.(txt|md|markdown|json|sql|log)$/i;
const TABLE_TYPES = /\.(csv|xlsx|xls)$/i;

export const GET: RequestHandler = async ({ request, url }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	const conversation = url.searchParams.get('conversation') ?? '';
	return json({ documents: await listDocs(user.username, conversation) });
};

export const POST: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	const form = await request.formData();
	const file = form.get('file');
	const conversationId = form.get('conversationId');
	if (!(file instanceof File)) return json({ error: 'No file provided' }, { status: 400 });
	if (typeof conversationId !== 'string' || !conversationId) {
		return json({ error: 'Missing conversationId' }, { status: 400 });
	}

	try {
		if (TABLE_TYPES.test(file.name)) {
			if (file.size > MAX_TABLE_SIZE) {
				return json({ error: 'Spreadsheet exceeds 8 MB limit' }, { status: 413 });
			}
			const sheets = parseWorkbook(Buffer.from(await file.arrayBuffer()));
			const doc = await addTabularDoc(user.username, conversationId, file.name, sheets);
			return json(
				{
					id: doc.id,
					name: doc.name,
					sheets: doc.sheets?.map((s) => ({ name: s.name, rows: s.rows.length }))
				},
				{ status: 201 }
			);
		}

		if (TEXT_TYPES.test(file.name)) {
			if (file.size > MAX_TEXT_SIZE) {
				return json({ error: 'File exceeds 16 MB limit' }, { status: 413 });
			}
			const doc = await addDoc(user.username, conversationId, file.name, await file.text());
			return json({ id: doc.id, name: doc.name, chunks: doc.chunks.length }, { status: 201 });
		}

		return json(
			{ error: 'Supported: spreadsheets (.csv .xlsx .xls) and text (.txt .md .json .sql .log)' },
			{ status: 415 }
		);
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Upload failed' },
			{ status: 400 }
		);
	}
};

export const DELETE: RequestHandler = async ({ request, url }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

	const id = url.searchParams.get('id');
	if (!id) return json({ error: 'Missing id' }, { status: 400 });
	await removeDoc(user.username, id);
	return json({ ok: true });
};

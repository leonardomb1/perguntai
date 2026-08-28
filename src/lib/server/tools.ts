import { tool } from 'ai';
import { z } from 'zod';
import { connectAsUser } from './db';
import { getConversationSandbox, runSandboxedPython } from './sandbox';
import { searchAllDocuments, getConversationDoc, getSheet, listTables, type SheetData } from './rag';
import { tableSchemas, schemaContext } from './schema';
import { visibleDatabases } from './warehouse-access';
import {
	createExcelExport,
	createFileExport,
	readExport,
	createTextExport,
	EXPORT_TYPES,
	type ExportExt,
	type ExportSheet
} from './exports';
import { checkStatement, readOnlyStatement } from './sql-guard';
import { saveMemory, removeMemory } from './memory';
import { proposeSkill, removeSkill, resolveSkill, saveSkill } from './skills';
import { compileTypstPdf, TypstCompileError } from './typst';
import { resolveTemplate, TEMPLATE_CONTENT_FILE } from './typstTemplates';
import { listSchedules as listUserSchedules, removeSchedule, saveSchedule } from './schedules';
import { invalidRecipients, sendReportEmail } from './email';
import { logAudit } from './audit';

/**
 * Tools available to the agent. Each tool runs server-side; the agent loop
 * (ToolLoopAgent) calls them autonomously and feeds results back to the model
 * until it produces a final answer.
 */
export const tools = {
	calculate: tool({
		description:
			'Evaluate an arithmetic expression exactly. Use this for any non-trivial math instead of computing mentally. Supports + - * / % ** and parentheses.',
		inputSchema: z.object({
			expression: z.string().describe('Arithmetic expression, e.g. "(1234.5 * 7) / 3"')
		}),
		execute: async ({ expression }) => {
			// Strict allowlist: digits, operators, parentheses, whitespace only —
			// no identifiers can be formed, so evaluation is safe.
			if (!/^[\d+\-*/%().\s]+$/.test(expression) || /[+\-*/%.]{3,}/.test(expression)) {
				return { error: 'Expression contains unsupported characters' };
			}
			try {
				const result = new Function(`"use strict"; return (${expression});`)();
				if (typeof result !== 'number' || !Number.isFinite(result)) {
					return { error: 'Expression did not evaluate to a finite number' };
				}
				return { expression, result };
			} catch {
				return { error: 'Invalid expression' };
			}
		}
	}),

	getCurrentTime: tool({
		description: 'Get the current date and time, optionally in a specific IANA timezone.',
		inputSchema: z.object({
			timezone: z
				.string()
				.optional()
				.describe('IANA timezone, e.g. "America/Sao_Paulo". Defaults to UTC.')
		}),
		execute: async ({ timezone }) => {
			try {
				const formatted = new Intl.DateTimeFormat('en-US', {
					dateStyle: 'full',
					timeStyle: 'long',
					timeZone: timezone ?? 'UTC'
				}).format(new Date());
				return { timezone: timezone ?? 'UTC', now: formatted, iso: new Date().toISOString() };
			} catch {
				return { error: `Unknown timezone "${timezone}"` };
			}
		}
	})
};

const MAX_SERIES = 8;

/**
 * Chart rendering: the tool validates the spec server-side and echoes it back;
 * the client renders the tool output as a Chart.js chart in the conversation.
 */
const MAX_HEATMAP_ROWS = 24;

export const chartTool = tool({
	description:
		'Render a chart in the conversation. Use after fetching data (e.g. via queryDatabase). ' +
		'Pick the form by the data’s job: line = trend over time; area = cumulative/volume trend; ' +
		'bar = comparison; horizontalBar = comparison with long category names or many categories; ' +
		'pie/doughnut/polarArea = share of a whole (few slices); scatter = correlation between two ' +
		'measures; bubble = correlation with a third measure as point size ({x,y,r}, r in pixels ' +
		'4-25); radar = multi-dimensional profile comparison; heatmap = intensity across two ' +
		'category dimensions (e.g. weekday × hour: labels are the columns, each dataset is one row). ' +
		'One chart per insight; prefer a markdown table when exact values matter more than their shape.',
	inputSchema: z.object({
		type: z.enum([
			'bar',
			'horizontalBar',
			'line',
			'area',
			'pie',
			'doughnut',
			'polarArea',
			'scatter',
			'bubble',
			'radar',
			'heatmap'
		]),
		title: z.string().describe('Short, insight-stating title'),
		labels: z
			.array(z.string())
			.optional()
			.describe(
				'Category/axis labels (slice names for pie; column names for heatmap). Omit for scatter/bubble.'
			),
		datasets: z
			.array(
				z.object({
					label: z.string().describe('Series name (row name for heatmap)'),
					data: z
						.union([
							z.array(z.number()),
							z.array(
								z.object({
									x: z.number(),
									y: z.number(),
									r: z.number().optional().describe('Bubble radius in px (bubble only)')
								})
							)
						])
						.describe('Numbers (one per label) — or {x,y}/{x,y,r} points for scatter/bubble')
				})
			)
			.min(1)
			.max(MAX_HEATMAP_ROWS)
			.describe(
				`Series: max ${MAX_SERIES} for most types, up to ${MAX_HEATMAP_ROWS} rows for heatmap; pie/doughnut/polarArea take exactly one`
			),
		stacked: z.boolean().optional().describe('Stack bar/area series (parts of a whole per category)'),
		xLabel: z.string().optional(),
		yLabel: z.string().optional().describe('Include the unit, e.g. "Revenue (R$)"')
	}),
	execute: async (spec) => {
		const isPoints = (d: unknown[]): boolean => typeof d[0] === 'object';
		if (spec.type === 'scatter' || spec.type === 'bubble') {
			const bad = spec.datasets.find((ds) => ds.data.length > 0 && !isPoints(ds.data));
			if (bad) return { error: `${spec.type} dataset "${bad.label}" must use {x,y} points` };
		} else {
			if (!spec.labels?.length) return { error: `${spec.type} charts require labels` };
			for (const ds of spec.datasets) {
				if (isPoints(ds.data)) {
					return {
						error: `Dataset "${ds.label}": {x,y} points are only for scatter/bubble charts`
					};
				}
				if (ds.data.length !== spec.labels.length) {
					return {
						error: `Dataset "${ds.label}" has ${ds.data.length} values but there are ${spec.labels.length} labels`
					};
				}
			}
			if (['pie', 'doughnut', 'polarArea'].includes(spec.type) && spec.datasets.length !== 1) {
				return { error: `${spec.type} charts take exactly one dataset` };
			}
		}
		if (spec.type !== 'heatmap' && spec.datasets.length > MAX_SERIES) {
			return { error: `${spec.type} charts support at most ${MAX_SERIES} series` };
		}
		// Echo the validated spec — the client renders it.
		return spec;
	}
});

/**
 * Mermaid diagrams: the tool echoes the source; the client renders the SVG.
 */
export const diagramTool = tool({
	description:
		'Render a Mermaid diagram in the conversation. Use for processes and flows (flowchart), ' +
		'interactions over time (sequenceDiagram), data models and table relationships (erDiagram), ' +
		'states (stateDiagram-v2), or timelines (gantt). Keep diagrams focused — under ~25 nodes.',
	inputSchema: z.object({
		title: z.string().describe('Short title stating what the diagram shows'),
		mermaid: z
			.string()
			.describe(
				'Valid Mermaid source, starting with the diagram type (e.g. "flowchart TD", "erDiagram", "sequenceDiagram")'
			)
	}),
	execute: async ({ title, mermaid }) => {
		const code = mermaid.trim();
		if (!code) return { error: 'Empty diagram source' };
		return { title, mermaid: code };
	}
});

/**
 * Preview an uploaded spreadsheet (CSV/Excel): columns + sample rows, so the
 * model understands the structure before reasoning about it.
 */
export function tablePreviewTool(
	username: string,
	conversationId: string,
	depts: { id: string; name: string }[]
) {
	return tool({
		description:
			'Inspect a spreadsheet (CSV/Excel) attached to this conversation: returns its columns, row count, ' +
			'and the first rows. ALWAYS call this before reasoning about an uploaded table.',
		inputSchema: z.object({
			document: z.string().describe('Uploaded document name (fuzzy match, e.g. "sales.xlsx")'),
			sheet: z.string().optional().describe('Sheet name for Excel files (defaults to the first)')
		}),
		execute: async ({ document, sheet }) => {
			const hit = await getSheet(username, conversationId, depts, document, sheet);
			if (!hit) {
				const available = await listTables(username, conversationId, depts);
				return {
					error: `No uploaded table matches "${document}"`,
					availableTables: available.length
						? available
						: 'none — no spreadsheets attached to this conversation'
				};
			}
			return {
				document: hit.document,
				sheet: hit.sheet.name,
				columns: hit.sheet.columns,
				rowCount: hit.sheet.rows.length,
				truncated: hit.sheet.truncated,
				sampleRows: hit.sheet.rows.slice(0, 15)
			};
		}
	});
}

const MAX_EXPORT_ROWS = 100_000;
const MAX_INLINE_EXPORT_ROWS = 2_000;

/**
 * Excel report generation. Each sheet's rows come either inline (small,
 * model-written summaries) or from a dataQuery — read-only SQL executed AS THE
 * LOGGED-IN USER whose full result (up to 100k rows) is written straight into
 * the workbook server-side, never passing through the model's context. The
 * client renders the output as a download card.
 */
export function excelReportTool(
	credentials: { username: string; password?: string },
	conversationId: string,
	depts: { id: string; name: string }[]
) {
	return tool({
		description:
			'Generate an Excel (.xlsx) report the user can download. Each sheet takes rows from ONE ' +
			'of: rows (inline objects — only for small, hand-written summaries), dataQuery ' +
			'(read-only SQL against the warehouse; the full result up to 100k rows is written ' +
			'server-side — ALWAYS prefer this for data exports), or document (an attached ' +
			'CSV/Excel). Use for any "export/report/planilha/relatório" request. After generating, ' +
			'briefly say what the report contains — the download button appears automatically.',
		inputSchema: z.object({
			filename: z.string().describe('Report file name, e.g. "incidents-report.xlsx"'),
			sheets: z
				.array(
					z.object({
						name: z.string().describe('Sheet tab name'),
						rows: z
							.array(z.record(z.string(), z.unknown()))
							.optional()
							.describe(`Inline rows (max ${MAX_INLINE_EXPORT_ROWS}) — small summaries only`),
						dataQuery: z
							.string()
							.optional()
							.describe(
								'Read-only SQL; its full result becomes the sheet. Fully qualify tables with their database (e.g. gold.table_name)'
							),
						document: z
							.string()
							.optional()
							.describe('Attached CSV/Excel document name to copy into the sheet'),
						sheet: z.string().optional().describe('Source sheet when document is an Excel file'),
						columns: z
							.array(z.string())
							.optional()
							.describe('Column order (defaults to the keys of the first row)')
					})
				)
				.min(1)
				.max(10)
		}),
		execute: async ({ filename, sheets }) => {
			const built: ExportSheet[] = [];
			let totalRows = 0;

			for (const spec of sheets) {
				const sources = [spec.rows, spec.dataQuery, spec.document].filter(
					(s) => s !== undefined
				).length;
				if (sources !== 1) {
					return { error: `Sheet "${spec.name}": provide exactly one of rows, dataQuery, document` };
				}

				let rows: Record<string, unknown>[];
				if (spec.rows) {
					if (spec.rows.length > MAX_INLINE_EXPORT_ROWS) {
						return {
							error: `Sheet "${spec.name}": inline rows capped at ${MAX_INLINE_EXPORT_ROWS} — use dataQuery for large data`
						};
					}
					rows = spec.rows;
				} else if (spec.dataQuery) {
					const statement = readOnlyStatement(spec.dataQuery);
					if (!statement) {
						return { error: `Sheet "${spec.name}": dataQuery must be a single read-only statement` };
					}
					let conn;
					try {
						conn = await connectAsUser(credentials, { selectDatabase: false });
						const [result] = await conn.query(statement);
						rows = jsonSafe(Array.isArray(result) ? result : [result]) as Record<
							string,
							unknown
						>[];
					} catch (error) {
						return {
							error: `Sheet "${spec.name}": ${error instanceof Error ? error.message : 'query failed'}`
						};
					} finally {
						await conn?.end().catch(() => {});
					}
				} else {
					const hit = await getSheet(credentials.username, conversationId, depts, spec.document!, spec.sheet);
					if (!hit) {
						return {
							error: `Sheet "${spec.name}": no attached table matches "${spec.document}"`,
							availableTables: await listTables(credentials.username, conversationId, depts)
						};
					}
					rows = hit.sheet.rows;
				}

				totalRows += rows.length;
				if (totalRows > MAX_EXPORT_ROWS) {
					return { error: `Report exceeds ${MAX_EXPORT_ROWS} total rows — aggregate or filter first` };
				}
				built.push({ name: spec.name, columns: spec.columns, rows });
			}

			const name = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
			const { id, bytes } = await createExcelExport(credentials.username, built);
			return {
				fileId: id,
				filename: name,
				bytes,
				sheets: built.map((s) => ({ name: s.name, rows: s.rows.length }))
			};
		}
	});
}

const MAX_DOCUMENT_CHARS = 400_000;

/**
 * Downloadable text documents (Markdown/plain/CSV) — the counterpart of
 * generateExcel for prose: "exporte esse documento em md". Same per-user
 * export store and authenticated download endpoint.
 */
export function documentExportTool(username: string) {
	return tool({
		description:
			'Create a downloadable text document from content you provide: Markdown (.md), plain ' +
			'text (.txt) or CSV (.csv). Use whenever the user asks to export/download a document, ' +
			'summary, spec or analysis as a file — e.g. “exporte em md”. Write the FULL document ' +
			'content; the user gets a download card. For tabular reports prefer generateExcel.',
		inputSchema: z.object({
			filename: z.string().describe('File name, e.g. modelo-ssma.md (extension optional)'),
			format: z.enum(['md', 'txt', 'csv']).default('md'),
			content: z.string().describe('Full document content (Markdown for md)')
		}),
		execute: async ({ filename, format, content }) => {
			if (!content.trim()) return { error: 'content is empty' };
			if (content.length > MAX_DOCUMENT_CHARS) {
				return { error: `Document exceeds ${MAX_DOCUMENT_CHARS} characters — split it into parts` };
			}
			const clean = filename.replace(/[^\w.\- ()]/g, '_').replace(/\.(md|txt|csv)$/i, '');
			const { id, bytes } = await createTextExport(username, content, format);
			return { fileId: id, filename: `${clean || 'documento'}.${format}`, bytes, format };
		}
	});
}

/**
 * Programado from chat: after a conversation lands on an analysis worth
 * repeating, the model distills it into standing instructions and schedules
 * it. The schedule then runs headless on its cadence (see scheduler.ts).
 */
export function scheduleTools(username: string) {
	return {
		scheduleReport: tool({
			description:
				'Schedule a recurring automatic run of an analysis (Programado). Distill THIS ' +
				'conversation\u2019s analysis into complete standing instructions — exact tables, filters ' +
				'and output format, plus e-mail recipients if the user wants delivery — because each run ' +
				'starts from scratch with no conversation context. ONLY call after the user explicitly ' +
				'asked to schedule and confirmed the cadence. Pass an existing id to UPDATE.',
			inputSchema: z.object({
				id: z.string().optional().describe('Existing schedule id to UPDATE; omit to create'),
				title: z.string().describe('Short name, e.g. "Ativos de TI semanal"'),
				instructions: z
					.string()
					.describe('Complete standing instructions for each run (self-contained)'),
				frequency: z.enum(['daily', 'weekly', 'monthly']),
				time: z.string().describe('Time of day HH:MM (24h, server timezone)'),
				weekday: z
					.number()
					.optional()
					.describe('weekly only: 0=Sunday … 6=Saturday'),
				dayOfMonth: z.number().optional().describe('monthly only: 1–28')
			}),
			execute: async ({ id, title, instructions, frequency, time, weekday, dayOfMonth }) => {
				const result = await saveSchedule(username, {
					id,
					title,
					instructions,
					frequency,
					time,
					weekday,
					dayOfMonth
				});
				if (!result.ok) {
					return {
						ok: false,
						reason: result.reason,
						hint:
							result.reason === 'full'
								? 'Schedule limit reached — delete one first (listSchedules/deleteSchedule).'
								: result.reason === 'not_found'
									? 'No schedule with that id — omit id to create.'
									: 'title and instructions are required.'
					};
				}
				return {
					ok: true,
					id: result.schedule.id,
					title: result.schedule.title,
					note: 'Visible in the sidebar under Programado; first run at the next occurrence.'
				};
			}
		}),
		listSchedules: tool({
			description: 'List the user\u2019s scheduled runs (Programado) with their ids and cadences.',
			inputSchema: z.object({}),
			execute: async () => ({
				schedules: (await listUserSchedules(username)).map((s) => ({
					id: s.id,
					title: s.title,
					frequency: s.frequency,
					time: s.time,
					enabled: s.enabled,
					lastRunAt: s.lastRunAt
				}))
			})
		}),
		deleteSchedule: tool({
			description:
				'Delete one of the user\u2019s scheduled runs by id — only when they explicitly ask.',
			inputSchema: z.object({ id: z.string().describe('Schedule id') }),
			execute: async ({ id }) => {
				const ok = await removeSchedule(username, id);
				return ok ? { ok: true } : { ok: false, error: `no schedule with id "${id}"` };
			}
		})
	};
}

const MAX_EMAIL_RECIPIENTS = 10;
const MAX_EMAIL_BODY = 20_000;

/**
 * Send a branded report e-mail. The model fills a CONSTRAINED schema (subject,
 * greeting, markdown body, optional CTA) rendered through one tested
 * table-based template — it never writes raw e-mail HTML (Outlook renders
 * with Word's engine; hand-written markup breaks silently). Attachments
 * reference the user's OWN exports by fileId, composing with generatePdf /
 * generateExcel. Recipient domains are allow-listed; every send is audited.
 */
export function emailReportTool(username: string) {
	return tool({
		description:
			'Send a branded HTML report e-mail, optionally attaching a file you already generated in ' +
			'this conversation (pass the fileId returned by generatePdf/generateExcel/generateDocument). ' +
			'ONLY call this when the user explicitly asked to send an e-mail, and confirm the recipients ' +
			'with them first. The body is markdown (paragraphs, **bold**, lists, pipe tables) rendered ' +
			'into the organization\u2019s template — write a concise executive summary, not the whole ' +
			'report (the attachment carries the detail). Recipients must belong to allowed domains.',
		inputSchema: z.object({
			to: z.array(z.string()).min(1).max(MAX_EMAIL_RECIPIENTS).describe('Recipient e-mail addresses'),
			subject: z.string().describe('E-mail subject — also shown as the title band'),
			bodyMarkdown: z
				.string()
				.describe('Body in markdown: short executive summary, key numbers, optional pipe table'),
			greeting: z.string().optional().describe('Greeting line, e.g. "Olá Equipe," (default none)'),
			ctaText: z.string().optional().describe('Optional call-to-action button label'),
			ctaUrl: z.string().optional().describe('Optional call-to-action URL (required with ctaText)'),
			attachmentFileId: z
				.string()
				.optional()
				.describe('fileId of an export generated in this conversation to attach'),
			attachmentName: z
				.string()
				.optional()
				.describe('Attachment filename shown to recipients (default: the export id)')
		}),
		execute: async ({ to, subject, bodyMarkdown, greeting, ctaText, ctaUrl, attachmentFileId, attachmentName }) => {
			const recipients = to.map((r) => r.trim()).filter(Boolean);
			const bad = invalidRecipients(recipients);
			if (bad.length) {
				return { error: `recipients outside the allowed domains: ${bad.join(', ')}` };
			}
			if (bodyMarkdown.length > MAX_EMAIL_BODY) {
				return { error: `bodyMarkdown exceeds ${MAX_EMAIL_BODY} characters — summarize; the detail belongs in the attachment` };
			}
			let attachment;
			if (attachmentFileId) {
				const hit = await readExport(username, attachmentFileId);
				if (!hit) return { error: 'attachmentFileId not found among your exports (expired?)' };
				const clean = (attachmentName?.trim() || `relatorio.${hit.ext}`).replace(/[^\w.\- ()]/g, '_');
				attachment = {
					filename: clean.endsWith(`.${hit.ext}`) ? clean : `${clean}.${hit.ext}`,
					content: hit.buffer,
					contentType: EXPORT_TYPES[hit.ext].split(';')[0]
				};
			}
			try {
				const { messageId } = await sendReportEmail({
					to: recipients,
					subject,
					bodyMarkdown,
					greeting,
					ctaText,
					ctaUrl,
					attachment
				});
				logAudit({
					actor: username,
					via: 'session',
					category: 'chat',
					action: 'email.send',
					target: subject,
					status: 'ok',
					detail: { to: recipients, attachment: attachment?.filename }
				});
				return { ok: true, messageId, to: recipients, attachment: attachment?.filename };
			} catch (error) {
				logAudit({
					actor: username,
					via: 'session',
					category: 'chat',
					action: 'email.send',
					status: 'error',
					detail: { to: recipients }
				});
				return { error: error instanceof Error ? error.message : 'send failed' };
			}
		}
	});
}

const MAX_TYPST_SOURCE = 120_000;

/**
 * Model-authored PDF reports via Typst (in-process compile, ~tens of ms).
 * The model writes real Typst source — full layout freedom — and iterates on
 * the structured compile diagnostics when it gets something wrong. Data flows
 * in through `dataQuery` (read-only SQL as the user, rows delivered as
 * sys.inputs JSON), never by pasting rows into markup.
 */
export function pdfReportTool(username: string, credentials: { username: string; password?: string }) {
	return tool({
		description:
			'Create a polished, professional PDF document from Typst source you write — reports, briefs, ' +
			'formatted analyses. Prefer this over generateDocument whenever presentation matters. Write ' +
			'complete Typst markup (set page/text rules, headings, tables, colors). To include warehouse ' +
			'data, pass dataQuery (a single read-only SQL statement, executed with the user\u2019s own ' +
			'permissions, up to 2000 rows): the rows arrive as JSON in sys.inputs — read them with ' +
			'#let data = json(bytes(sys.inputs.at("data", default: "[]"))) and build tables from that, ' +
			'NEVER paste row values into the source. When <pdf_templates> lists a matching template, ' +
			'pass its name as `template` and write ONLY the document body (no page/text setup — the ' +
			'template supplies layout and branding). On a compile error, fix the source using the ' +
			'diagnostics (only the first error is reported — fixing one may reveal the next) and retry. ' +
			'The user gets a download card and an inline preview.',
		inputSchema: z.object({
			filename: z.string().describe('File name, e.g. relatorio-frota.pdf (extension optional)'),
			source: z.string().describe('Complete Typst source for the document'),
			dataQuery: z
				.string()
				.optional()
				.describe('Single read-only SQL statement — its rows become sys.inputs.data (JSON array)'),
			template: z
				.string()
				.optional()
				.describe('Name of an organization PDF template from <pdf_templates>; source is then the BODY only')
		}),
		execute: async ({ filename, source, dataQuery, template }) => {
			if (!source.trim()) return { error: 'source is empty' };
			if (source.length > MAX_TYPST_SOURCE) {
				return { error: `source exceeds ${MAX_TYPST_SOURCE} characters` };
			}
			let inputs: Record<string, string> | undefined;
			if (dataQuery?.trim()) {
				const statement = checkStatement(dataQuery, { allowWrites: false });
				if (!statement) {
					return { error: 'dataQuery must be a single read-only statement (SELECT/SHOW/DESCRIBE/EXPLAIN)' };
				}
				let conn;
				try {
					conn = await connectAsUser(credentials, { selectDatabase: false });
					const [result] = await conn.query(statement);
					if (!Array.isArray(result)) return { error: 'dataQuery returned no row set' };
					const rows = (jsonSafe(result) as Record<string, unknown>[]).slice(0, 2000);
					inputs = { data: JSON.stringify(rows) };
				} catch (error) {
					return { error: error instanceof Error ? error.message : 'dataQuery failed' };
				} finally {
					await conn?.end().catch(() => {});
				}
			}
			try {
				let main = source;
				let files: Record<string, string> | undefined;
				if (template?.trim()) {
					const resolved = await resolveTemplate(template);
					if (!resolved) return { error: `no enabled PDF template matches "${template}"` };
					main = resolved.source;
					files = { [TEMPLATE_CONTENT_FILE]: source };
				}
				const { pdf, pages } = await compileTypstPdf(main, inputs, files);
				const clean = filename.replace(/[^\w.\- ()]/g, '_').replace(/\.pdf$/i, '');
				const { id, bytes } = await createFileExport(username, Buffer.from(pdf), 'pdf');
				return { fileId: id, filename: `${clean || 'documento'}.pdf`, bytes, format: 'pdf', pages };
			} catch (error) {
				if (error instanceof TypstCompileError) {
					return { error: error.message, diagnostics: error.diagnostics };
				}
				return { error: error instanceof Error ? error.message : 'compile failed' };
			}
		}
	});
}

/**
 * Column details from the locally synced schema.json — instant, no database
 * round-trip. The table catalog itself is already in the system prompt.
 */
/**
 * Warehouse catalog (every table/view name + comment), served as a tool rather
 * than injected into every system prompt — so a chat that never touches the
 * warehouse doesn't carry it, and the always-cached prompt prefix stays lean.
 * The model calls this the moment it needs to find a table.
 */
export function warehouseCatalogTool(credentials: { username: string; password?: string }) {
	return tool({
		description:
			'List the available data-warehouse tables/views (names + descriptions) across the synced ' +
			'databases. Call this FIRST whenever a question needs warehouse data and you are not already ' +
			'sure which table holds it — then call getTableSchema for the columns of the tables you will ' +
			'query. The list is already scoped to what THIS user can access. Instant; replaces SHOW TABLES.',
		inputSchema: z.object({}),
		execute: async () => {
			const visible = await visibleDatabases(credentials);
			const catalog = await schemaContext(visible);
			if (!catalog) return { error: 'No synced schema available — fall back to SHOW TABLES.' };
			return { catalog };
		}
	});
}

/**
 * Ask the user to pick among a few concrete options. It has NO execute — the
 * chat UI renders the options as buttons and the user's choice comes back as
 * the tool result (client-resolved / human-in-the-loop). Lets the model
 * disambiguate precisely instead of guessing (wrong queries) or writing a long
 * free-text clarifying question.
 */
export const askUserTool = tool({
	description:
		'Ask the user to choose among a few concrete options when their request is ambiguous — e.g. which ' +
		'time period, status, table/system, or metric. STRONGLY prefer this over guessing (which produces ' +
		'wrong answers) or a long free-text clarifying question: the user gets buttons and picks one, and ' +
		'their choice returns as the result. Use 2–5 short, mutually-exclusive options. Do NOT use it for ' +
		'open-ended questions that need a typed answer.',
	inputSchema: z.object({
		question: z.string().describe('One short, specific clarifying question'),
		// Plain array of strings (NOT objects) — some models/providers emit
		// malformed JSON for nested object arrays in tool inputs.
		options: z
			.array(z.string())
			.min(2)
			.max(5)
			.describe('2–5 short, mutually-exclusive option labels (each returned verbatim if chosen)')
	})
	// No execute — resolved by the chat UI when the user clicks a button.
});

/**
 * User-memory tools (opt-in, per-user). Memory is organized by TOPIC — each with
 * a title, a one-line summary, and a markdown details body. The agent records
 * durable, self-scoped knowledge with saveMemory (creating a new topic or
 * updating an existing one by id) and removes topics with forgetMemory. Inputs
 * are flat scalars only — some models/providers emit malformed JSON for nested
 * object arrays in tool inputs. The current topics (with ids) are injected into
 * the system prompt, so the model can update or forget one by id. Only added to
 * the toolset when the user enabled memory (see buildAgent).
 */
/**
 * Learned-skill tools: the agent's procedural memory (see skills.ts). useSkill
 * loads a playbook before a task; saveSkill captures one after a hard-won
 * success; proposeSkill sends a personal skill to admin review for sharing.
 * Flat scalar inputs only, like the memory tools.
 */
export function skillTools(
	username: string,
	conversationId: string,
	depts: { id: string; name: string }[]
) {
	return {
		useSkill: tool({
			description:
				'Load one of your learned skills (listed in <available_skills>) by name or id and get its ' +
				'full playbook. ALWAYS call this BEFORE starting a task that matches a listed skill — the ' +
				'playbook has the exact tables, filters, pitfalls and verification steps that worked before.',
			inputSchema: z.object({
				skill: z.string().describe('Skill name (fuzzy) or id from <available_skills>')
			}),
			execute: async ({ skill }) => {
				const hit = await resolveSkill(username, depts, skill);
				if (!hit) return { error: `no skill matches "${skill}"` };
				return { id: hit.skill.id, name: hit.skill.name, scope: hit.scope, content: hit.skill.content };
			}
		}),
		saveSkill: tool({
			description:
				'Capture a reusable PROCEDURE as a learned skill after completing a task that took several ' +
				'steps, non-obvious fixes, or corrections from the user — so next time you follow the ' +
				'playbook instead of rediscovering it. Pass an existing skill id to UPDATE it (better ' +
				'approach found, new pitfall hit — resend the FULL merged content). Content is markdown: ' +
				'the exact procedure (tables, columns, filters), pitfalls to avoid, and how to verify the ' +
				'result. Never store data values or personal facts (memory covers those). After saving, ' +
				'tell the user in one line.',
			inputSchema: z.object({
				id: z.string().optional().describe('Existing skill id to UPDATE; omit to create'),
				name: z.string().describe('Short imperative name, e.g. "Calcular SLA de TI"'),
				description: z.string().describe('One line: when this skill applies'),
				content: z.string().describe('Markdown playbook: procedure, pitfalls, verification')
			}),
			execute: async ({ id, name, description, content }) => {
				const result = await saveSkill(
					username,
					{ id, name, description, content },
					'agent',
					conversationId
				);
				if (result.ok) return { ok: true, id: result.skill.id, name: result.skill.name };
				return {
					ok: false,
					reason: result.reason,
					hint:
						result.reason === 'full'
							? 'Skill list is full — forgetSkill an outdated one or update an existing id.'
							: result.reason === 'not_found'
								? 'No skill with that id — omit id to create a new one.'
								: 'name and content are required.'
				};
			}
		}),
		forgetSkill: tool({
			description: 'Delete one of the user\u2019s learned skills by id (outdated or wrong procedure).',
			inputSchema: z.object({ id: z.string().describe('Skill id to delete') }),
			execute: async ({ id }) => {
				const ok = await removeSkill(username, id);
				return ok ? { ok: true } : { ok: false, error: `no skill with id "${id}"` };
			}
		}),
		proposeSkill: tool({
			description:
				'Propose one of this user\u2019s skills for SHARED use (whole organization or one of their ' +
				'departments). It does NOT activate immediately — an admin reviews and approves it in the ' +
				'console first. Use when the user agrees a skill would help colleagues; tell them it went ' +
				'to review.',
			inputSchema: z.object({
				id: z.string().describe('The user skill id to propose'),
				scope: z
					.string()
					.describe('"org" for the whole organization, or a department id from your context')
			}),
			execute: async ({ id, scope }) => {
				const target =
					scope === 'org' ? 'org' : depts.some((d) => d.id === scope) ? `dept-${scope}` : null;
				if (!target) {
					return {
						error: `scope must be "org" or one of the user's department ids: ${depts.map((d) => d.id).join(', ') || '(none)'}`
					};
				}
				const result = await proposeSkill(username, id, target);
				if (result.ok) return { ok: true, status: 'pending admin review' };
				return {
					ok: false,
					error:
						result.reason === 'duplicate'
							? 'a shared skill with this name already exists in that scope'
							: `no personal skill with id "${id}"`
				};
			}
		})
	};
}

export function memoryTools(username: string, conversationId: string) {
	return {
		saveMemory: tool({
			description:
				'Record durable, self-scoped knowledge about the CURRENT USER, organized by topic. To add ' +
				'to something you already remember, pass the existing topic id (from your memory list) to ' +
				'UPDATE it; omit id to create a NEW topic. Keep the title short (e.g. "Creative Writing", ' +
				'"Reporting preferences"), the summary to one line, and put the specifics in details ' +
				'(markdown — bullet lists are ideal). When updating, resend the FULL merged content, not ' +
				'just the delta. Save only lasting facts about THIS user: never one-off task details, never ' +
				'data values, never facts about other people, never sensitive personal data. After saving, ' +
				'briefly tell the user you will remember it.',
			inputSchema: z.object({
				id: z.string().optional().describe('Existing topic id to UPDATE; omit to create a new topic'),
				title: z.string().describe('Short topic title'),
				summary: z.string().describe('One-line description of the topic'),
				details: z
					.string()
					.optional()
					.describe('The specifics, in markdown (bullet lists welcome). Resend the full merged body when updating.')
			}),
			execute: async ({ id, title, summary, details }) => {
				const result = await saveMemory(username, { id, title, summary, details }, 'agent', conversationId);
				if (result.ok) return { ok: true, id: result.memory.id, title: result.memory.title };
				return {
					ok: false,
					reason: result.reason,
					hint:
						result.reason === 'full'
							? 'Memory is full — forgetMemory an outdated topic first, or update an existing one by id.'
							: result.reason === 'not_found'
								? 'No topic with that id — omit id to create a new one.'
								: 'Nothing to save.'
				};
			}
		}),
		forgetMemory: tool({
			description:
				'Delete a memory topic, addressed by its id. Use when the user asks you to forget something, ' +
				'or a whole topic is no longer relevant.',
			inputSchema: z.object({
				id: z.string().describe('The id of the topic to forget')
			}),
			execute: async ({ id }) => {
				const ok = await removeMemory(username, id);
				return ok ? { ok: true } : { ok: false, error: `No memory topic with id "${id}"` };
			}
		})
	};
}

export function tableSchemaTool(credentials: { username: string; password?: string }) {
	return tool({
		description:
			'Get the exact columns (names, types, comments) of one or more tables/views from the synced ' +
			'schema. ALWAYS call this before writing SQL against a table you haven’t inspected in this ' +
			'conversation — it is instant and replaces DESCRIBE.',
		inputSchema: z.object({
			tables: z
				.array(z.string())
				.min(1)
				.max(8)
				.describe('Database-qualified table/view names from the catalog (e.g. gold.table_name)')
		}),
		execute: async ({ tables }) => {
			const visible = await visibleDatabases(credentials);
			const result = await tableSchemas(tables, visible);
			if (!result) return { error: 'No synced schema available — fall back to DESCRIBE' };
			return result;
		}
	});
}

/**
 * RAG retrieval over the user's uploaded documents. Built per-request so it
 * searches only the logged-in user's own store.
 */
export function documentSearchTool(
	username: string,
	conversationId: string,
	depts: { id: string; name: string }[]
) {
	return tool({
		description:
			'Search the documents available to you — files the user attached to THIS conversation PLUS the ' +
			'organization and department reference libraries. Use whenever a question might be answered by such ' +
			'material — reports, policies, notes, definitions. Returns the most relevant excerpts, each labeled ' +
			'with the library it came from (source); cite the document name (and its library) when you use them.',
		inputSchema: z.object({
			query: z.string().describe('Search query — key terms work better than full sentences')
		}),
		execute: async ({ query }) => {
			const hits = await searchAllDocuments(username, conversationId, depts, query);
			if (hits.length === 0) {
				return {
					hits: [],
					note: 'No matching content in the attached documents or reference libraries.'
				};
			}
			return { hits };
		}
	});
}

const MAX_ROWS = 200;

/**
 * mysql2 returns DATETIME columns as JS Date objects (plus occasional BigInt/
 * Buffer). Those aren't valid JSON content for the agent loop — the SDK
 * rejects the tool result on the NEXT model call with a Zod validation error.
 * Convert everything to plain JSON values before returning rows.
 */
function jsonSafe(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'bigint') return value.toString();
	if (Buffer.isBuffer(value)) return value.toString('utf8');
	if (Array.isArray(value)) return value.map(jsonSafe);
	if (typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
	}
	if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
	return value;
}

const MAX_SANDBOX_INPUT_ROWS = 20_000;
const MAX_SANDBOX_INPUT_BYTES = 8 * 1024 * 1024;

/**
 * BETA — sandboxed Python on microsandbox microVMs (hardware isolation via
 * libkrun/KVM). Registered only when the admin enabled the codeExecution
 * capability. `dataQuery` runs read-only AS THE USER and feeds the full result
 * into the sandbox server-side, so datasets never pass through the model.
 */
export function sandboxPythonTool(credentials: { username: string; password?: string }) {
	return tool({
		description:
			'Run a Python script in an isolated sandbox for advanced analysis: statistics, forecasting, ' +
			'regressions, clustering, transformations beyond SQL. The script runs top-level (no main() ' +
			'needed) and MUST print its findings (print(...) — prefer compact JSON or small tables); ' +
			'stdout is the result. pandas/numpy are available; other imports may be missing. To feed ' +
			'warehouse data WITHOUT pasting rows, pass dataQuery (a single read-only SQL statement, ' +
			'database-qualified names, executed with the user\u2019s own permissions, up to ' +
			`${MAX_SANDBOX_INPUT_ROWS} rows) — its rows arrive as the preloaded variable \`data\` ` +
			'(a list of dicts). Return small summaries, never large arrays; if the user then needs a ' +
			'chart, print the aggregated series and feed it to renderChart.',
		inputSchema: z.object({
			code: z.string().describe('Python source; runs top-level with `data` preloaded; print results'),
			dataQuery: z
				.string()
				.optional()
				.describe('Read-only SQL whose full result becomes the `data` variable')
		}),
		execute: async ({ code, dataQuery }) => {
			let data: unknown[] | undefined;
			if (dataQuery?.trim()) {
				const statement = checkStatement(dataQuery, { allowWrites: false });
				if (!statement) {
					return { error: 'dataQuery must be a single read-only statement (SELECT/SHOW/DESCRIBE/EXPLAIN)' };
				}
				let conn;
				try {
					conn = await connectAsUser(credentials, { selectDatabase: false });
					const [result] = await conn.query(statement);
					if (!Array.isArray(result)) return { error: 'dataQuery returned no row set' };
					const rows = (jsonSafe(result) as Record<string, unknown>[]).slice(
						0,
						MAX_SANDBOX_INPUT_ROWS
					);
					if (JSON.stringify(rows).length > MAX_SANDBOX_INPUT_BYTES) {
						return {
							error: `dataQuery result exceeds ${MAX_SANDBOX_INPUT_BYTES / 1024 / 1024} MiB — aggregate or select fewer columns`
						};
					}
					data = rows;
				} catch (error) {
					return { error: error instanceof Error ? error.message : 'dataQuery failed' };
				} finally {
					await conn?.end().catch(() => {});
				}
			}
			try {
				const run = await runSandboxedPython(code, data);
				return run.ok
					? { output: run.stdout, durationMs: run.durationMs, rows: data?.length }
					: { error: run.stderr || run.stdout || `exit ${run.exitCode}`, durationMs: run.durationMs };
			} catch (error) {
				return {
					error: `sandbox unavailable: ${error instanceof Error ? error.message : String(error)}`
				};
			}
		}
	});
}


const MAX_FILE_READ_CHARS = 24_000;

/**
 * BETA — Claude-style file tools over the conversation's PERSISTENT sandbox
 * workspace (one named microVM per conversation; files survive across turns,
 * stopped when idle, removed with the conversation). The point is DELTAS:
 * sandboxEditFile changes only the passed span, so iterating on a script or
 * document never re-emits its full content through the model.
 */
function csvCell(value: unknown): string {
	const text = value == null ? '' : String(value);
	return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sheetToCsv(sheet: SheetData): string {
	const header = sheet.columns.map(csvCell).join(',');
	const lines = sheet.rows.map((r) => sheet.columns.map((c) => csvCell(r[c])).join(','));
	return [header, ...lines].join('\n');
}

export function sandboxFileTools(
	credentials: { username: string; password?: string },
	conversationId: string
) {
	const username = credentials.username;
	const resolvePath = (w: string, path: string) =>
		path.startsWith('/') ? path : `${w}/${path}`;

	return {
		sandboxLoadData: tool({
			description:
				'Fetch warehouse data into the sandbox workspace WITHOUT it passing through you: runs a ' +
				'single read-only SQL statement (database-qualified names, executed with the user\u2019s own ' +
				`permissions, up to ${MAX_SANDBOX_INPUT_ROWS} rows) and writes the full result as a JSON ` +
				'array of row objects to a workspace file. Then analyze it with sandboxExec (python/basalt).',
			inputSchema: z.object({
				sql: z.string().describe('A single read-only SQL statement'),
				path: z
					.string()
					.optional()
					.describe('Workspace file to write (default data.json)')
			}),
			execute: async ({ sql, path }) => {
				const statement = checkStatement(sql, { allowWrites: false });
				if (!statement) {
					return { error: 'sql must be a single read-only statement (SELECT/SHOW/DESCRIBE/EXPLAIN)' };
				}
				let conn;
				try {
					conn = await connectAsUser(credentials, { selectDatabase: false });
					const [result] = await conn.query(statement);
					if (!Array.isArray(result)) return { error: 'query returned no row set' };
					const rows = (jsonSafe(result) as Record<string, unknown>[]).slice(
						0,
						MAX_SANDBOX_INPUT_ROWS
					);
					const body = JSON.stringify(rows);
					if (body.length > MAX_SANDBOX_INPUT_BYTES) {
						return {
							error: `result exceeds ${MAX_SANDBOX_INPUT_BYTES / 1024 / 1024} MiB — aggregate or select fewer columns`
						};
					}
					const { sandbox, workdir } = await getConversationSandbox(username, conversationId);
					const full = resolvePath(workdir, path?.trim() || 'data.json');
					await sandbox.fs().write(full, body);
					return {
						path: full,
						rows: rows.length,
						columns: rows.length ? Object.keys(rows[0]) : []
					};
				} catch (error) {
					return { error: error instanceof Error ? error.message : 'load failed' };
				} finally {
					await conn?.end().catch(() => {});
				}
			}
		}),
		sandboxWriteFile: tool({
			description:
				'Create or overwrite a file in this conversation\u2019s persistent sandbox workspace ' +
				'(relative paths resolve inside the workspace). Files persist across turns. For SMALL ' +
				'changes to an existing file use sandboxEditFile instead of rewriting it here.',
			inputSchema: z.object({
				path: z.string().describe('File path (relative to the workspace, or absolute)'),
				content: z.string().describe('Full file content')
			}),
			execute: async ({ path, content }) => {
				try {
					const { sandbox, workdir } = await getConversationSandbox(username, conversationId);
					const full = resolvePath(workdir, path);
					const dir = full.slice(0, full.lastIndexOf('/'));
					if (dir) await sandbox.fs().mkdir(dir).catch(() => {});
					await sandbox.fs().write(full, content);
					return { path: full, bytes: Buffer.byteLength(content) };
				} catch (error) {
					return { error: error instanceof Error ? error.message : 'write failed' };
				}
			}
		}),
		sandboxReadFile: tool({
			description:
				'Read a file from this conversation\u2019s sandbox workspace. Long files are truncated ' +
				`at ${MAX_FILE_READ_CHARS} characters — prefer targeted sandboxExec (head/grep) for huge files.`,
			inputSchema: z.object({
				path: z.string().describe('File path (relative to the workspace, or absolute)')
			}),
			execute: async ({ path }) => {
				try {
					const { sandbox, workdir } = await getConversationSandbox(username, conversationId);
					const text = await sandbox.fs().readToString(resolvePath(workdir, path));
					return {
						content: text.slice(0, MAX_FILE_READ_CHARS),
						truncated: text.length > MAX_FILE_READ_CHARS
					};
				} catch (error) {
					return { error: error instanceof Error ? error.message : 'read failed' };
				}
			}
		}),
		sandboxEditFile: tool({
			description:
				'Edit a workspace file by exact-string replacement — pass ONLY the span to change plus ' +
				'its replacement, never the whole file. oldText must match exactly once (include enough ' +
				'surrounding context to make it unique), or set replaceAll for every occurrence.',
			inputSchema: z.object({
				path: z.string().describe('File path (relative to the workspace, or absolute)'),
				oldText: z.string().describe('Exact text to replace (must currently be in the file)'),
				newText: z.string().describe('Replacement text'),
				replaceAll: z.boolean().optional().describe('Replace every occurrence (default: exactly one)')
			}),
			execute: async ({ path, oldText, newText, replaceAll }) => {
				try {
					const { sandbox, workdir } = await getConversationSandbox(username, conversationId);
					const full = resolvePath(workdir, path);
					const text = await sandbox.fs().readToString(full);
					const count = text.split(oldText).length - 1;
					if (count === 0) return { error: 'oldText not found in file' };
					if (count > 1 && !replaceAll) {
						return {
							error: `oldText matches ${count} times — add surrounding context to make it unique, or set replaceAll`
						};
					}
					const next = replaceAll
						? text.split(oldText).join(newText)
						: text.replace(oldText, newText);
					await sandbox.fs().write(full, next);
					return { replaced: replaceAll ? count : 1, bytes: Buffer.byteLength(next) };
				} catch (error) {
					return { error: error instanceof Error ? error.message : 'edit failed' };
				}
			}
		}),
		sandboxExec: tool({
			description:
				'Run a shell command in this conversation\u2019s sandbox workspace (cwd = the workspace; ' +
				'python and basalt are available). Output is truncated — keep it compact (head, wc, > file).',
			inputSchema: z.object({
				command: z.string().describe('Shell command line (sh -c)')
			}),
			execute: async ({ command }) => {
				try {
					const { sandbox, workdir } = await getConversationSandbox(username, conversationId);
					const out = await sandbox.execWith('sh', (b) =>
						b.arg('-c').arg(command).cwd(workdir).timeout(60_000)
					);
					return {
						exitCode: out.code,
						stdout: out.stdout().slice(0, MAX_FILE_READ_CHARS),
						stderr: out.stderr().slice(0, 4000)
					};
				} catch (error) {
					return { error: error instanceof Error ? error.message : 'exec failed' };
				}
			}
		}),
		sandboxImportDoc: tool({
			description:
				'Copy a document the user attached to THIS conversation into the sandbox workspace so ' +
				'you can analyze it for real: spreadsheets are written as CSV (one file per sheet), text ' +
				'documents as their full text, under uploads/. ALWAYS use this instead of searchDocuments ' +
				'when the user wants computation, statistics or transformation over an attached file.',
			inputSchema: z.object({
				name: z.string().describe('Attached document name (fuzzy match ok)')
			}),
			execute: async ({ name }) => {
				try {
					const doc = await getConversationDoc(username, conversationId, name);
					if (!doc) return { error: `no attached document matches "${name}" in this conversation` };
					const { sandbox, workdir } = await getConversationSandbox(username, conversationId);
					const slug =
						doc.name
							.replace(/\.[^.]+$/, '')
							.replace(/[^\w.-]+/g, '_')
							.slice(0, 60) || 'documento';
					const files: { path: string; rows?: number; bytes: number; truncated?: boolean }[] = [];
					const writeOne = async (path: string, body: string) => {
						const full = `${workdir}/uploads/${path}`;
						await sandbox.fs().mkdir(`${workdir}/uploads`).catch(() => {});
						await sandbox.fs().write(full, body);
						return full;
					};
					if (doc.sheets?.length) {
						for (const sheet of doc.sheets) {
							const suffix = doc.sheets.length > 1 ? `-${sheet.name.replace(/[^\w.-]+/g, '_')}` : '';
							const body = sheetToCsv(sheet);
							files.push({
								path: await writeOne(`${slug}${suffix}.csv`, body),
								rows: sheet.rows.length,
								bytes: Buffer.byteLength(body),
								...(sheet.truncated ? { truncated: true } : {})
							});
						}
					} else {
						const body = doc.chunks.join('\n\n');
						files.push({ path: await writeOne(`${slug}.txt`, body), bytes: Buffer.byteLength(body) });
					}
					return { document: doc.name, files };
				} catch (error) {
					return { error: error instanceof Error ? error.message : 'import failed' };
				}
			}
		}),
		sandboxPresentFile: tool({
			description:
				'Deliver a workspace file to the user: it appears in the chat as a downloadable file card ' +
				'(text formats also open in the viewer panel). ALWAYS use this when you have produced a ' +
				'file the user should receive — a report, dataset, or document — instead of pasting its ' +
				`content. Supported formats: ${Object.keys(EXPORT_TYPES).join(', ')}.`,
			inputSchema: z.object({
				path: z.string().describe('Workspace file to deliver'),
				filename: z
					.string()
					.optional()
					.describe('Download name shown to the user (default: the file\u2019s own name)')
			}),
			execute: async ({ path, filename }) => {
				try {
					const { sandbox, workdir } = await getConversationSandbox(username, conversationId);
					const full = resolvePath(workdir, path);
					const name = (filename?.trim() || full.split('/').pop() || 'arquivo').replace(
						/[^\w.\- ()]/g,
						'_'
					);
					const ext = (name.split('.').pop() ?? '').toLowerCase();
					if (!(ext in EXPORT_TYPES)) {
						return {
							error: `unsupported format .${ext} — supported: ${Object.keys(EXPORT_TYPES).join(', ')}`
						};
					}
					// base64 through exec: the SDK fs API is text-only, this handles any file.
					const out = await sandbox.exec('base64', ['-w0', full]);
					if (out.code !== 0) return { error: out.stderr().trim() || 'file not found' };
					const buffer = Buffer.from(out.stdout().replace(/\s/g, ''), 'base64');
					if (buffer.length === 0) return { error: 'file is empty' };
					if (buffer.length > MAX_SANDBOX_INPUT_BYTES) {
						return { error: `file exceeds ${MAX_SANDBOX_INPUT_BYTES / 1024 / 1024} MiB` };
					}
					const { id } = await createFileExport(username, buffer, ext as ExportExt);
					return { fileId: id, filename: name, bytes: buffer.length, format: ext };
				} catch (error) {
					return { error: error instanceof Error ? error.message : 'present failed' };
				}
			}
		})
	};
}

/**
 * SQL tool against StarRocks, built per-request because it connects AS THE
 * LOGGED-IN USER (credentials from the encrypted bearer token), so the database
 * enforces that user's own grants.
 *
 * Read-only unless an admin granted this user sqlWrite, which widens the guard
 * to ordinary DML (see sql-guard). The caller resolves the flag and passes it in
 * — the guard itself is never widened globally, so the other SQL entry points
 * (flow sqlCheck, generateExcel) stay read-only for everyone.
 */
export function starrocksQueryTool(
	credentials: { username: string; password?: string },
	{ allowWrites = false }: { allowWrites?: boolean } = {}
) {
	return tool({
		description:
			(allowWrites
				? 'Run a SQL query against the StarRocks data warehouse, executed with the current user’s own ' +
					'database permissions. Reads (SELECT / SHOW / DESCRIBE / EXPLAIN) and writes (INSERT / UPDATE / ' +
					'DELETE / CREATE TABLE) are both allowed for this user; DROP, TRUNCATE and ALTER are always ' +
					'rejected. Before running anything that modifies data, show the user the exact statement and ask ' +
					'them to confirm — never write on your own initiative, and never as a step inside a larger task ' +
					'they did not ask for. '
				: 'Run a read-only SQL query (SELECT / SHOW / DESCRIBE / EXPLAIN) against the StarRocks ' +
					'data warehouse, executed with the current user’s own database permissions. ') +
			'ALWAYS fully qualify every table with its database (e.g. gold.table_name, ' +
			'bronze.table_name) — the connection has NO default database, so unqualified names fail. ' +
			`Results are capped at ${MAX_ROWS} rows — aggregate or LIMIT accordingly.`,
		inputSchema: z.object({
			sql: z
				.string()
				.describe(
					allowWrites
						? 'A single SQL statement with database-qualified table names'
						: 'A single read-only SQL statement with database-qualified table names'
				)
		}),
		execute: async ({ sql }) => {
			const statement = checkStatement(sql, { allowWrites });
			if (!statement) {
				return {
					error: allowWrites
						? 'Rejected: only a single statement per call, and DROP/TRUNCATE/ALTER (plus INSERT OVERWRITE ' +
							'and CREATE OR REPLACE) are never allowed. SELECT/SHOW/DESCRIBE/EXPLAIN and ' +
							'INSERT/UPDATE/DELETE/CREATE are permitted.'
						: 'Only single read-only statements (SELECT/SHOW/DESCRIBE/EXPLAIN) are allowed'
				};
			}
			let conn;
			try {
				conn = await connectAsUser(credentials, { selectDatabase: false });
				const [result] = await conn.query(statement);
				// Writes come back as a ResultSetHeader, not a row array.
				if (!Array.isArray(result)) {
					const { affectedRows } = result as { affectedRows?: number };
					return { affectedRows: affectedRows ?? 0 };
				}
				const list = jsonSafe(result) as Record<string, unknown>[];
				return {
					rowCount: list.length,
					truncated: list.length > MAX_ROWS,
					rows: list.slice(0, MAX_ROWS)
				};
			} catch (error) {
				return { error: error instanceof Error ? error.message : 'Query failed' };
			} finally {
				await conn?.end().catch(() => {});
			}
		}
	});
}

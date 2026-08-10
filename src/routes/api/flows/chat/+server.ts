import { json } from '@sveltejs/kit';
import { createAgentUIStreamResponse } from 'ai';
import { env } from '$env/dynamic/private';
import { authenticateRequest } from '$lib/server/auth';
import { connectMcpTools } from '$lib/server/mcp';
import { buildFlowBuilderAgent } from '$lib/server/agent-flow';
import { withHeartbeat } from '$lib/server/heartbeat';
import { getUserSettings } from '$lib/server/settings';
import {
	departmentsForUser,
	getAccessEntry,
	getDepartments,
	resolveModel,
	resolveRole
} from '$lib/server/access';
import { addUsage, usageToday, weightedTokens } from '$lib/server/usage';
import { isValidFlowId, loadFlowById, resolveFlowAccess } from '$lib/server/flows';
import type { RequestHandler } from './$types';

/**
 * Streaming endpoint for the Flows page's dedicated builder chat. Builder/admin
 * only. Runs the focused flow-builder agent (upsertFlow/getFlow + read-only
 * warehouse + Windmill facade). `flowId` (optional) names the flow being edited
 * (requires edit access; writes go to the OWNER's store); omitted means composing
 * a brand-new flow, which requires a `departmentId` the caller may use.
 */
export const POST: RequestHandler = async ({ request }) => {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	const role = await resolveRole(user.username);
	if (role !== 'admin' && role !== 'builder') return json({ error: 'Forbidden' }, { status: 403 });

	const access = await getAccessEntry(user.username);
	let tokenBudget: number | null = null;
	if (access?.maxDailyTokens) {
		const used = await usageToday(user.username);
		if (used >= access.maxDailyTokens) {
			return json(
				{ error: 'Limite diário de tokens atingido — fale com o administrador ou tente amanhã.' },
				{ status: 429 }
			);
		}
		tokenBudget = access.maxDailyTokens - used;
	}

	const { messages, flowId, departmentId: rawDept, conversationId, model: requestedModel } =
		await request.json();
	const boundFlowId = typeof flowId === 'string' && isValidFlowId(flowId) ? flowId : null;
	const model = await resolveModel(user.username, typeof requestedModel === 'string' ? requestedModel : '');

	// Resolve who owns the flow being written and (for a new flow) its department.
	const matchedDepts = await departmentsForUser(user.profile);
	let ownerUsername = user.username;
	let departmentId: string | null = null;
	if (boundFlowId) {
		const record = await loadFlowById(boundFlowId);
		if (!record) return json({ error: 'Flow not found' }, { status: 404 });
		const acc = resolveFlowAccess(record, user.username, role, new Set(matchedDepts.map((d) => d.id)));
		if (acc !== 'owner' && acc !== 'admin') return json({ error: 'Forbidden' }, { status: 403 });
		ownerUsername = record.owner;
	} else {
		const wanted = typeof rawDept === 'string' ? rawDept : null;
		const allowed =
			role === 'admin'
				? (await getDepartments()).some((d) => d.id === wanted)
				: matchedDepts.some((d) => d.id === wanted);
		if (!wanted || !allowed) return json({ error: 'department_required' }, { status: 400 });
		departmentId = wanted;
	}

	const settings = await getUserSettings(user.username);
	// The builder needs to list/inspect Windmill scripts (notify targets); writes
	// stay off — flow authoring goes through upsertFlow, not raw Windmill CRUD.
	const mcp = await connectMcpTools(
		{ windmill: settings.windmillToken, tabula: settings.tabulaToken },
		{ allowWrites: false }
	);

	let totalTokens = 0;

	// Keepalive for long first-token silences on CPU inference (see heartbeat.ts).
	return withHeartbeat(await createAgentUIStreamResponse({
		agent: await buildFlowBuilderAgent(
			user,
			settings,
			mcp.tools,
			typeof conversationId === 'string' ? conversationId : `flow:${boundFlowId ?? 'new'}`,
			boundFlowId,
			ownerUsername,
			departmentId,
			model,
			tokenBudget
		),
		uiMessages: messages,
		abortSignal: request.signal,
		onStepEnd: (event) => {
			totalTokens += weightedTokens(event.usage);
		},
		onFinish: async () => {
			await mcp.close();
			await addUsage(user.username, totalTokens).catch((e) => console.warn('usage tracking failed:', e));
		},
		onError: (error) => {
			if (env.DEBUG_USAGE === '1') console.error('flow-builder stream error:', error);
			return error instanceof Error ? error.message.slice(0, 300) : String(error);
		}
	}));
};

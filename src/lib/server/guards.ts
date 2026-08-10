import { json } from '@sveltejs/kit';
import { authenticateRequest, type AuthUser } from './auth';
import { departmentsForUser, resolveRole, type Role } from './access';
import { isValidFlowId, loadFlowById, resolveFlowAccess } from './flows';
import type { FlowAccess, FlowRecord } from '$lib/flow-spec';

/** Role is enforced HERE, per request — hiding a page is UX, not security. */
export async function requireBuilder(request: Request): Promise<AuthUser | Response> {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	const role = await resolveRole(user.username);
	if (role !== 'admin' && role !== 'builder') return json({ error: 'Forbidden' }, { status: 403 });
	return user;
}

/**
 * What a caller wants to do with a flow:
 * - view / run — any viewer (owner, admin, or a matching department member)
 * - edit       — owner or admin (edit/delete/deactivate/assign act on the owner's store)
 * - activate   — OWNER only: activation seals the activator's live credentials as
 *                the flow's run-as identity, which nobody else can produce.
 */
export type FlowNeed = 'view' | 'run' | 'edit' | 'activate';

export interface FlowAccessCtx {
	user: AuthUser;
	role: Role;
	/** The flow (owner resolved via the global index). */
	record: FlowRecord;
	access: FlowAccess;
}

export async function requireFlowAccess(
	request: Request,
	id: string,
	need: FlowNeed
): Promise<FlowAccessCtx | Response> {
	const user = await authenticateRequest(request);
	if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
	const role = await resolveRole(user.username);
	if (role !== 'admin' && role !== 'builder') return json({ error: 'Forbidden' }, { status: 403 });
	if (!isValidFlowId(id)) return json({ error: 'Invalid flow id' }, { status: 400 });
	const record = await loadFlowById(id);
	if (!record) return json({ error: 'Flow not found' }, { status: 404 });

	const matched = new Set((await departmentsForUser(user.profile)).map((d) => d.id));
	const access = resolveFlowAccess(record, user.username, role, matched);
	const ok =
		need === 'activate'
			? access === 'owner'
			: need === 'edit'
				? access === 'owner' || access === 'admin'
				: access !== 'none'; // view / run
	if (!ok) return json({ error: 'Forbidden', access }, { status: 403 });
	return { user, role, record, access };
}

import { getToken } from '$lib/session';
import type { UIMessage } from 'ai';
import type { FlowAccess, FlowListItem, FlowRun, FlowTrace, PublicFlowRecord } from '$lib/flow-spec';

/** A flow record plus how the caller may act on it. */
export type FlowRecordWithAccess = PublicFlowRecord & { access: FlowAccess };
export interface FlowDepartmentOption {
	id: string;
	name: string;
}

/**
 * Flows client — flows live SERVER-SIDE (per user, under DATA_DIR) and their
 * GRAPH is edited only through the chat tools; this wrapper covers the viewer
 * page reads plus the lifecycle actions (activate/deactivate/run/delete).
 */

function headers(json = false): Record<string, string> {
	return {
		Authorization: `Bearer ${getToken() ?? ''}`,
		...(json ? { 'Content-Type': 'application/json' } : {})
	};
}

export async function listFlows(): Promise<FlowListItem[]> {
	try {
		const res = await fetch('/api/flows', { headers: headers() });
		if (!res.ok) return [];
		return (await res.json()).flows;
	} catch {
		return [];
	}
}

export async function getFlow(id: string): Promise<FlowRecordWithAccess | null> {
	try {
		const res = await fetch(`/api/flows/${encodeURIComponent(id)}`, { headers: headers() });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

/** Departments the caller may assign a flow to (admin: all; builder: their own). */
export async function listFlowDepartments(): Promise<FlowDepartmentOption[]> {
	try {
		const res = await fetch('/api/flows/departments', { headers: headers() });
		if (!res.ok) return [];
		return (await res.json()).departments ?? [];
	} catch {
		return [];
	}
}

export async function assignFlowDepartment(
	id: string,
	departmentId: string | null
): Promise<FlowRecordWithAccess | null> {
	try {
		const res = await fetch(`/api/flows/${encodeURIComponent(id)}/department`, {
			method: 'PUT',
			headers: headers(true),
			body: JSON.stringify({ departmentId })
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export type FlowActionResult =
	| { ok: true; record: PublicFlowRecord }
	| { ok: false; error: string };

async function lifecycle(id: string, action: string, body?: object): Promise<FlowActionResult> {
	try {
		const res = await fetch(`/api/flows/${encodeURIComponent(id)}/${action}`, {
			method: 'POST',
			headers: headers(true),
			body: JSON.stringify(body ?? {})
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
		return { ok: true, record: data };
	} catch {
		return { ok: false, error: 'network' };
	}
}

export const activateFlow = (id: string, version?: number) =>
	lifecycle(id, 'activate', version ? { version } : {});
export const deactivateFlow = (id: string) => lifecycle(id, 'deactivate');

export async function runFlow(id: string): Promise<{ jobId?: string; error?: string }> {
	try {
		const res = await fetch(`/api/flows/${encodeURIComponent(id)}/run`, {
			method: 'POST',
			headers: headers(true),
			body: '{}'
		});
		return await res.json();
	} catch {
		return { error: 'network' };
	}
}

export async function deleteFlow(id: string): Promise<boolean> {
	try {
		const res = await fetch(`/api/flows/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			headers: headers()
		});
		return res.ok;
	} catch {
		return false;
	}
}

export async function listRuns(id: string): Promise<FlowRun[]> {
	try {
		const res = await fetch(`/api/flows/${encodeURIComponent(id)}/runs`, { headers: headers() });
		if (!res.ok) return [];
		return (await res.json()).runs;
	} catch {
		return [];
	}
}

/** The builder-chat transcript for a flow — resumes editing where it left off. */
export async function loadFlowChat(id: string): Promise<UIMessage[]> {
	try {
		const res = await fetch(`/api/flows/${encodeURIComponent(id)}/history`, { headers: headers() });
		if (!res.ok) return [];
		return (await res.json()).messages ?? [];
	} catch {
		return [];
	}
}

export async function saveFlowChat(id: string, messages: UIMessage[]): Promise<void> {
	try {
		await fetch(`/api/flows/${encodeURIComponent(id)}/history`, {
			method: 'PUT',
			headers: headers(true),
			body: JSON.stringify({ messages })
		});
	} catch {
		/* best-effort */
	}
}

export async function listTraces(id: string): Promise<FlowTrace[]> {
	try {
		const res = await fetch(`/api/flows/${encodeURIComponent(id)}/traces`, { headers: headers() });
		if (!res.ok) return [];
		return (await res.json()).traces;
	} catch {
		return [];
	}
}

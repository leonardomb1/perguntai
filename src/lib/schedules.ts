import { getToken } from '$lib/session';

/** Client for /api/schedules — the user's own Programado entries. */

export interface UserSchedule {
	id: string;
	title: string;
	instructions: string;
	frequency: 'daily' | 'weekly' | 'monthly';
	time: string;
	weekday?: number;
	dayOfMonth?: number;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
	lastRunAt?: string;
}

export interface ScheduleRun {
	id: string;
	startedAt: string;
	finishedAt: string;
	status: 'ok' | 'error';
	text: string;
	tools: string[];
	tokens: number;
	error?: string;
}

export interface ScheduleInput {
	id?: string;
	title: string;
	instructions: string;
	frequency: 'daily' | 'weekly' | 'monthly';
	time: string;
	weekday?: number;
	dayOfMonth?: number;
	enabled?: boolean;
}

function headers(): Record<string, string> {
	return { Authorization: `Bearer ${getToken() ?? ''}`, 'Content-Type': 'application/json' };
}

export async function fetchSchedules(): Promise<{
	enabled: boolean;
	schedules: UserSchedule[];
} | null> {
	try {
		const res = await fetch('/api/schedules', { headers: headers() });
		if (!res.ok) return null;
		const data = await res.json();
		return { enabled: data.enabled === true, schedules: data.schedules ?? [] };
	} catch {
		return null;
	}
}

export async function saveSchedule(input: ScheduleInput): Promise<UserSchedule | null> {
	try {
		const res = await fetch('/api/schedules', {
			method: 'POST',
			headers: headers(),
			body: JSON.stringify(input)
		});
		if (!res.ok) return null;
		return (await res.json()).schedule ?? null;
	} catch {
		return null;
	}
}

export async function deleteSchedule(id: string): Promise<boolean> {
	try {
		const res = await fetch(`/api/schedules?id=${encodeURIComponent(id)}`, {
			method: 'DELETE',
			headers: headers()
		});
		return res.ok;
	} catch {
		return false;
	}
}

export async function fetchRuns(id: string): Promise<ScheduleRun[]> {
	try {
		const res = await fetch(`/api/schedules/${encodeURIComponent(id)}/runs`, {
			headers: headers()
		});
		if (!res.ok) return [];
		return (await res.json()).runs ?? [];
	} catch {
		return [];
	}
}


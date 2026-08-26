import { appendFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';

/**
 * Append-only audit trail, modeled on the Azure Activity Log's essentials:
 * who (actor + credential + client context), what (category/action/target),
 * outcome (status), and a free-form detail blob. One JSONL file per month
 * under DATA_DIR/audit/, pruned past RETENTION_MONTHS.
 *
 * Categories follow Azure's control-plane/data-plane split:
 *  - auth        sign-ins (both doors) and rejections
 *  - admin       console mutations (users, policies, org knowledge)
 *  - keys        API key lifecycle
 *  - connectors  MCP/connector configuration changes
 *  - chat        data-plane requests (one event per /api/chat call)
 */

export type AuditCategory = 'auth' | 'admin' | 'keys' | 'connectors' | 'chat';

export interface AuditEvent {
	ts: string;
	/** Username performing (or attempting) the action. */
	actor: string;
	via: 'session' | 'apikey';
	/** Set when `via` is apikey — WHICH credential/app made the call. */
	keyId?: string;
	keyLabel?: string;
	ip?: string;
	/** User-Agent — identifies the calling app for programmatic access. */
	ua?: string;
	category: AuditCategory;
	/** Operation name, dot-scoped: 'login', 'user.patch', 'chat.request'… */
	action: string;
	/** The thing acted on: a username, policy name, key label, model id… */
	target?: string;
	status: 'ok' | 'denied' | 'error';
	detail?: Record<string, unknown>;
}

const RETENTION_MONTHS = 6;

function auditDir(): string {
	return join(env.DATA_DIR ?? 'data', 'audit');
}

const monthFile = (d: Date) => `${d.toISOString().slice(0, 7)}.jsonl`;

/** Client context from the incoming request, for the who-column. */
export function requestMeta(request: Request): { ip?: string; ua?: string } {
	const fwd = request.headers.get('x-forwarded-for');
	const ip = (fwd?.split(',')[0] ?? request.headers.get('x-real-ip'))?.trim();
	const ua = request.headers.get('user-agent')?.slice(0, 160);
	return { ...(ip ? { ip } : {}), ...(ua ? { ua } : {}) };
}

// Serialize appends; interleaved writes would corrupt lines.
let queue: Promise<void> = Promise.resolve();

/** Fire-and-forget: auditing must never fail or slow the audited request. */
export function logAudit(event: Omit<AuditEvent, 'ts'>): void {
	const full: AuditEvent = { ts: new Date().toISOString(), ...event };
	queue = queue
		.then(async () => {
			const dir = auditDir();
			await mkdir(dir, { recursive: true });
			await appendFile(join(dir, monthFile(new Date())), JSON.stringify(full) + '\n');
		})
		.catch((e) => console.warn('audit write failed:', e));
}

/** Newest-first events, across the two most recent month files. */
export async function readAudit(opts: {
	limit?: number;
	category?: AuditCategory;
	actor?: string;
} = {}): Promise<AuditEvent[]> {
	const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
	const now = new Date();
	const months = [monthFile(now), monthFile(new Date(now.getFullYear(), now.getMonth() - 1, 15))];

	const events: AuditEvent[] = [];
	for (const file of months) {
		try {
			const raw = await readFile(join(auditDir(), file), 'utf8');
			for (const line of raw.split('\n')) {
				if (!line.trim()) continue;
				try {
					events.push(JSON.parse(line));
				} catch {
					// A torn line never poisons the whole log.
				}
			}
		} catch {
			// Missing month file — nothing logged then.
		}
	}

	const actor = opts.actor?.trim().toLowerCase();
	return events
		.filter((e) => (!opts.category || e.category === opts.category) &&
			(!actor || e.actor.toLowerCase().includes(actor)))
		.sort((a, b) => (a.ts < b.ts ? 1 : -1))
		.slice(0, limit);
}

/** Drop month files past retention. Called opportunistically from reads. */
export async function pruneAudit(): Promise<void> {
	try {
		const cutoff = new Date();
		cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);
		const floor = monthFile(cutoff);
		for (const f of await readdir(auditDir())) {
			if (f.endsWith('.jsonl') && f < floor) await rm(join(auditDir(), f), { force: true });
		}
	} catch {
		// Best effort.
	}
}

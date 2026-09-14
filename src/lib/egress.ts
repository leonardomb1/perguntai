/**
 * Sandbox egress allow-list entries — the one grammar shared by the admin
 * console (validation, badges) and the server (sanitizing, compiling into a
 * microsandbox network policy). Deny-by-default: an entry only ever ADDS a
 * destination; there is no "allow all" spelling.
 *
 *   pypi.org                  one host (exact FQDN)
 *   *.pythonhosted.org        every host under a suffix
 *   10.20.0.0/24              an IPv4 CIDR block
 *   10.20.0.5                 one IPv4 address (stored as /32)
 *   host:5432  host:80,443    explicit guest-side ports (default 443, 80)
 *   host:8000-8100            a port range
 *
 * Destinations that can never be allowed (loopback, link-local/metadata, and
 * the app's own host) are rejected here — they are also pinned as leading
 * deny rules when the policy is compiled, so a stale record can't reopen them.
 */

export type EgressKind = 'domain' | 'suffix' | 'cidr';
/** Where the destination lives: public internet, an RFC1918/CGNAT range, or a never-allowed range. */
export type EgressScope = 'public' | 'private' | 'blocked';

export interface EgressRule {
	kind: EgressKind;
	/** Canonical destination: lower-cased host, `*.suffix`, or `a.b.c.d/nn`. */
	value: string;
	/** Inclusive guest-side port ranges; always non-empty (defaults applied). */
	ports: { start: number; end: number }[];
	scope: EgressScope;
	/** Canonical text form — what gets stored. */
	text: string;
}

export const DEFAULT_EGRESS_PORTS: { start: number; end: number }[] = [
	{ start: 443, end: 443 },
	{ start: 80, end: 80 }
];
export const MAX_EGRESS_RULES = 40;

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function parsePorts(text: string): EgressRule['ports'] | null {
	const out: EgressRule['ports'] = [];
	for (const part of text.split(',')) {
		const p = part.trim();
		if (!p) return null;
		const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(p);
		if (!m) return null;
		const start = Number(m[1]);
		const end = m[2] ? Number(m[2]) : start;
		if (start < 1 || end > 65535 || end < start) return null;
		out.push({ start, end });
	}
	return out.length ? out : null;
}

function portsText(ports: EgressRule['ports']): string {
	return ports.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`)).join(',');
}

function isDefaultPorts(ports: EgressRule['ports']): boolean {
	return portsText(ports) === portsText(DEFAULT_EGRESS_PORTS);
}

function parseIpv4(s: string): number | null {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
	if (!m) return null;
	let n = 0;
	for (let i = 1; i <= 4; i++) {
		const o = Number(m[i]);
		if (o > 255) return null;
		n = n * 256 + o;
	}
	return n;
}

/** Ranges that must never be reachable from model-written code. */
const BLOCKED_V4: [number, number][] = [
	[parseIpv4('127.0.0.0')!, 8],
	[parseIpv4('169.254.0.0')!, 16], // link-local, cloud metadata endpoints
	[parseIpv4('0.0.0.0')!, 8],
	[parseIpv4('224.0.0.0')!, 4], // multicast
	[parseIpv4('240.0.0.0')!, 4] // reserved + broadcast
];
/** Ranges the app container can usually reach — allowed, but flagged in the console. */
const PRIVATE_V4: [number, number][] = [
	[parseIpv4('10.0.0.0')!, 8],
	[parseIpv4('172.16.0.0')!, 12],
	[parseIpv4('192.168.0.0')!, 16],
	[parseIpv4('100.64.0.0')!, 10] // CGNAT
];

function overlaps(base: number, bits: number, rangeBase: number, rangeBits: number): boolean {
	const b = Math.min(bits, rangeBits);
	const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
	return ((base & mask) >>> 0) === ((rangeBase & mask) >>> 0);
}

function cidrScope(base: number, bits: number): EgressScope {
	if (BLOCKED_V4.some(([rb, rbits]) => overlaps(base, bits, rb, rbits))) return 'blocked';
	if (PRIVATE_V4.some(([rb, rbits]) => overlaps(base, bits, rb, rbits))) return 'private';
	return 'public';
}

function hostScope(host: string): EgressScope {
	if (host === 'localhost' || host.endsWith('.localhost')) return 'blocked';
	if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return 'private';
	return 'public';
}

/**
 * Parse one entry. Returns null for anything malformed or for a destination
 * that can never be allowed (scope 'blocked' is never returned — those are
 * rejected outright so the UI shows them as invalid).
 */
export function parseEgressRule(input: string): EgressRule | null {
	let text = input.trim().toLowerCase();
	if (!text || text.length > 300 || /\s/.test(text)) return null;

	// Split an optional trailing :ports — but not the "/" of a CIDR.
	let ports: EgressRule['ports'] = DEFAULT_EGRESS_PORTS;
	const colon = text.lastIndexOf(':');
	if (colon > 0) {
		const parsed = parsePorts(text.slice(colon + 1));
		if (!parsed) return null;
		ports = parsed;
		text = text.slice(0, colon);
	}
	if (!text) return null;

	// CIDR / single IPv4
	const slash = text.indexOf('/');
	const ipPart = slash >= 0 ? text.slice(0, slash) : text;
	const ip = parseIpv4(ipPart);
	if (ip !== null) {
		let bits = 32;
		if (slash >= 0) {
			if (!/^\d{1,2}$/.test(text.slice(slash + 1))) return null;
			bits = Number(text.slice(slash + 1));
			if (bits < 8 || bits > 32) return null; // /0../7 = effectively "the internet"
		}
		const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
		const base = (ip & mask) >>> 0;
		const scope = cidrScope(base, bits);
		if (scope === 'blocked') return null;
		const value = `${[24, 16, 8, 0].map((s) => (base >>> s) & 255).join('.')}/${bits}`;
		return { kind: 'cidr', value, ports, scope, text: isDefaultPorts(ports) ? value : `${value}:${portsText(ports)}` };
	}
	if (slash >= 0) return null;

	// Domain / suffix
	const suffix = text.startsWith('*.');
	const host = suffix ? text.slice(2) : text;
	const labels = host.split('.');
	// FQDNs only (at least one dot): bare intranet names are ambiguous across
	// resolvers — reach those hosts by CIDR instead.
	if (labels.length < 2 || host.length > 253 || !labels.every((l) => LABEL.test(l))) return null;
	const scope = hostScope(host);
	if (scope === 'blocked') return null;
	const value = suffix ? `*.${host}` : host;
	return {
		kind: suffix ? 'suffix' : 'domain',
		value,
		ports,
		scope,
		text: isDefaultPorts(ports) ? value : `${value}:${portsText(ports)}`
	};
}

/** Canonical, de-duplicated, capped list from any stored/submitted array. */
export function sanitizeEgressRules(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (typeof item !== 'string') continue;
		const rule = parseEgressRule(item);
		if (rule) seen.add(rule.text);
		if (seen.size >= MAX_EGRESS_RULES) break;
	}
	return [...seen];
}

/** Display form of a rule's ports ("443, 80" / "8000–8100"). */
export function egressPortsLabel(rule: EgressRule): string {
	return rule.ports
		.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`))
		.join(', ');
}

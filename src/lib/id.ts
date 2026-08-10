/**
 * UUID v4 that works on insecure origins. `crypto.randomUUID` only exists in
 * secure contexts (https / localhost) — on plain-HTTP LAN deployments it is
 * undefined and calling it during component init blanks the whole page.
 * `crypto.getRandomValues` has no such restriction.
 */
export function newId(): string {
	if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

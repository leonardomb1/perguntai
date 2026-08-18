/**
 * Username + password sign-in against a directory over LDAPS.
 *
 * Two bind strategies, picked by configuration:
 *
 *   service account (preferred) — bind as LDAP_BIND_DN, search the user by
 *   LDAP_USER_FILTER, then bind again as the DN found with the password given.
 *   Works on AD and OpenLDAP alike, and reads the entry with an account whose
 *   read rights are known.
 *
 *   direct (UPN) — no service account: bind as `<username>@LDAP_DOMAIN` and read
 *   the entry with the person's own rights. AD accepts a UPN as a bind name;
 *   most other directories do not.
 *
 * Either way the outcome is an `IdentityClaims` object using the same claim
 * names the ID token path emits (`preferred_username`, `name`, `email`,
 * `groups`, …), so sessionFromClaims and department matching see one shape
 * whichever door a person came in through. `groups` carries each membership
 * both as its DN and its bare CN, since admins type either into a match rule.
 */

import { readFileSync } from 'node:fs';
import { env } from '$env/dynamic/private';
import { Client, InvalidCredentialsError, SizeLimitExceededError, type Entry } from 'ldapts';
import type { IdentityClaims } from './auth';

export type LdapRejection = 'invalid' | 'disabled' | 'locked' | 'expired';

export type LdapResult =
	| { ok: true; claims: IdentityClaims }
	| { ok: false; reason: LdapRejection; code?: string };

/**
 * Claim name → directory attribute. Extend with LDAP_CLAIMS, e.g.
 * `cost_center=extensionAttribute1,cost_center_description=extensionAttribute2`
 * so the cost-centre rules in the org panel see AD's values.
 */
const DEFAULT_CLAIM_MAP: Record<string, string> = {
	name: 'displayName',
	email: 'mail',
	title: 'title',
	employee_id: 'employeeID'
};

/**
 * AD reports why a bind failed in the `data NNN` fragment of the error text —
 * the result code alone is always 49. Only the ones a person can act on get
 * their own message; the rest read as a bad password so the form leaks nothing.
 */
const AD_SUBCODES: Record<string, LdapRejection> = {
	'525': 'invalid', // user not found
	'52e': 'invalid', // wrong password
	'530': 'disabled', // logon hours restriction
	'531': 'disabled', // workstation restriction
	'532': 'expired', // password expired
	'533': 'disabled', // account disabled
	'701': 'disabled', // account expired
	'773': 'expired', // must change password
	'775': 'locked' // account locked
};

export function ldapConfigured(): boolean {
	return !!env.LDAP_URL;
}

function timeoutMs(): number {
	const n = Number(env.LDAP_TIMEOUT_MS || 10_000);
	return Number.isFinite(n) && n > 0 ? n : 10_000;
}

/** RFC 4515: the five characters that would let a username rewrite the filter. */
export function escapeFilterValue(value: string): string {
	return value.replace(/[\\*()\0]/g, (c) => {
		switch (c) {
			case '\\':
				return '\\5c';
			case '*':
				return '\\2a';
			case '(':
				return '\\28';
			case ')':
				return '\\29';
			default:
				return '\\00';
		}
	});
}

/**
 * People type what they type: `DOMAIN\jdoe`, `jdoe@corp.example.com`, `jdoe`.
 * All three name the same account, so the search always runs on the bare form.
 */
export function bareUsername(identifier: string): string {
	let name = identifier.trim();
	const slash = name.lastIndexOf('\\');
	if (slash >= 0) name = name.slice(slash + 1);
	const at = name.indexOf('@');
	if (at > 0) name = name.slice(0, at);
	return name;
}

/** The AD `data NNN` sub-code out of a bind failure, when there is one. */
export function adSubcode(message: string): string | undefined {
	return /\bdata\s+([0-9a-f]{3})\b/i.exec(message)?.[1]?.toLowerCase();
}

export function classifyBindFailure(message: string): { reason: LdapRejection; code?: string } {
	const code = adSubcode(message);
	return { reason: (code && AD_SUBCODES[code]) || 'invalid', code };
}

function tlsOptions() {
	const opts: { rejectUnauthorized: boolean; ca?: string } = {
		rejectUnauthorized: env.LDAP_TLS_REJECT_UNAUTHORIZED !== 'false'
	};
	const caPath = env.LDAP_CA_CERT;
	if (caPath) opts.ca = readFileSync(caPath, 'utf8');
	return opts;
}

function newClient(): Client {
	const url = env.LDAP_URL;
	if (!url) throw new Error('LDAP_URL is not set');
	return new Client({
		url,
		timeout: timeoutMs(),
		connectTimeout: timeoutMs(),
		tlsOptions: tlsOptions()
	});
}

function claimMap(): Record<string, string> {
	const map = { ...DEFAULT_CLAIM_MAP };
	// LDAP_CLAIMS="cost_center=extensionAttribute1,office=physicalDeliveryOfficeName"
	for (const pair of (env.LDAP_CLAIMS ?? '').split(/[|,]/)) {
		const [claim, attr] = pair.split('=').map((s) => s.trim());
		if (claim && attr) map[claim] = attr;
	}
	return map;
}

function usernameAttr(): string {
	return env.LDAP_USERNAME_ATTR || 'sAMAccountName';
}

function groupAttr(): string {
	return env.LDAP_GROUP_ATTR || 'memberOf';
}

function userFilter(username: string): string {
	const template = env.LDAP_USER_FILTER || `(${usernameAttr()}={{username}})`;
	return template.replaceAll('{{username}}', escapeFilterValue(username));
}

function text(value: Entry[string]): string | undefined {
	const first = Array.isArray(value) ? value[0] : value;
	if (first === undefined || first === null) return undefined;
	const s = Buffer.isBuffer(first) ? first.toString('utf8') : String(first);
	return s.trim() ? s.trim() : undefined;
}

function list(value: Entry[string]): string[] {
	if (value === undefined || value === null) return [];
	const arr = Array.isArray(value) ? value : [value];
	return arr
		.map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v)))
		.filter((s) => s.length > 0);
}

/** The base DN: configured, or whatever the server names as its default context. */
async function baseDn(client: Client): Promise<string> {
	if (env.LDAP_BASE_DN) return env.LDAP_BASE_DN;
	const root = await client.search('', { scope: 'base', attributes: ['defaultNamingContext'] });
	const base = text(root.searchEntries[0]?.defaultNamingContext);
	if (!base) throw new Error('ldap: LDAP_BASE_DN is not set and the server names no default context');
	return base;
}

async function findUser(client: Client, username: string): Promise<Entry | null> {
	const attributes = [
		'dn',
		usernameAttr(),
		groupAttr(),
		...new Set(Object.values(claimMap()))
	];
	let entries: Entry[];
	try {
		({ searchEntries: entries } = await client.search(await baseDn(client), {
			scope: 'sub',
			filter: userFilter(username),
			attributes,
			sizeLimit: 2
		}));
	} catch (err) {
		if (err instanceof SizeLimitExceededError) return null;
		throw err;
	}
	// Two matches means the filter is ambiguous; treating either as "the" user
	// would let one account sign in as another. Refuse both.
	return entries.length === 1 ? entries[0] : null;
}

/**
 * Groups reachable through nesting, via AD's LDAP_MATCHING_RULE_IN_CHAIN.
 * Optional because it is AD-only and one more round trip on every sign-in.
 */
async function nestedGroups(client: Client, dn: string): Promise<string[]> {
	if (env.LDAP_NESTED_GROUPS !== 'true') return [];
	const { searchEntries } = await client.search(await baseDn(client), {
		scope: 'sub',
		filter: `(member:1.2.840.113556.1.4.1941:=${escapeFilterValue(dn)})`,
		attributes: ['dn']
	});
	return searchEntries.map((e) => e.dn);
}

/** Each group as its DN and its bare CN, deduplicated, so either form matches. */
export function groupNames(groups: string[]): string[] {
	// An escaped comma (`CN=Doe\, Jane`) is part of the name, not a separator.
	const names = groups.map((g) => /^cn=((?:\\.|[^,])+)/i.exec(g)?.[1]?.replace(/\\(.)/g, '$1') ?? g);
	return [...new Set([...groups, ...names])];
}

function claimsFrom(entry: Entry, groups: string[], fallbackUsername: string): IdentityClaims {
	const claims: IdentityClaims & Record<string, unknown> = {
		sub: entry.dn,
		preferred_username: text(entry[usernameAttr()]) ?? fallbackUsername,
		groups: groupNames(groups)
	};
	for (const [claim, attr] of Object.entries(claimMap())) {
		const value = text(entry[attr]);
		if (value) claims[claim] = value;
	}
	return claims;
}

async function bindAs(name: string, password: string): Promise<Client> {
	const client = newClient();
	try {
		await client.bind(name, password);
		return client;
	} catch (err) {
		await client.unbind().catch(() => {});
		throw err;
	}
}

async function serviceAccountFlow(username: string, password: string): Promise<LdapResult> {
	const service = await bindAs(env.LDAP_BIND_DN!, env.LDAP_BIND_PASSWORD ?? '');
	try {
		const entry = await findUser(service, username);
		if (!entry) return { ok: false, reason: 'invalid' };

		let user: Client;
		try {
			user = await bindAs(entry.dn, password);
		} catch (err) {
			if (err instanceof InvalidCredentialsError) {
				return { ok: false, ...classifyBindFailure(err.message) };
			}
			throw err;
		}
		await user.unbind().catch(() => {});

		const groups = [...list(entry[groupAttr()]), ...(await nestedGroups(service, entry.dn))];
		return { ok: true, claims: claimsFrom(entry, [...new Set(groups)], username) };
	} finally {
		await service.unbind().catch(() => {});
	}
}

async function directBindFlow(identifier: string, username: string, password: string): Promise<LdapResult> {
	const domain = env.LDAP_DOMAIN;
	const bindName = domain ? `${username}@${domain}` : identifier.trim();
	if (!bindName.includes('@') && !bindName.includes('\\')) {
		throw new Error('ldap: LDAP_DOMAIN is not set, so a bare username cannot be bound directly');
	}

	let user: Client;
	try {
		user = await bindAs(bindName, password);
	} catch (err) {
		if (err instanceof InvalidCredentialsError) {
			return { ok: false, ...classifyBindFailure(err.message) };
		}
		throw err;
	}

	try {
		const entry = await findUser(user, username).catch((err) => {
			console.warn('ldap: signed in but could not read own entry', err);
			return null;
		});
		if (!entry) {
			// Authenticated, but the directory shows us nothing: sign in with an
			// identity and no claims rather than refuse a valid password.
			return { ok: true, claims: { sub: bindName, preferred_username: username, groups: [] } };
		}
		const groups = [...list(entry[groupAttr()]), ...(await nestedGroups(user, entry.dn))];
		return { ok: true, claims: claimsFrom(entry, [...new Set(groups)], username) };
	} finally {
		await user.unbind().catch(() => {});
	}
}

/**
 * Verify a password and read the person's directory entry. Rejections a person
 * can act on come back as a result; anything about the directory itself — down,
 * misconfigured, service account refused — throws, so the form can say
 * "unavailable" instead of blaming the password.
 */
export async function ldapAuthenticate(identifier: string, password: string): Promise<LdapResult> {
	const username = bareUsername(identifier);
	// An empty password is an anonymous bind, which most directories ACCEPT.
	// Nothing below may run without a real credential.
	if (!username || !password) return { ok: false, reason: 'invalid' };

	return env.LDAP_BIND_DN
		? serviceAccountFlow(username, password)
		: directBindFlow(identifier, username, password);
}

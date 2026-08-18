/**
 * Department membership rules, shared by the server (which enforces them) and
 * the admin console (which previews "matches you") so the two cannot disagree.
 *
 * A rule names a sign-in claim — whatever the OIDC id_token or the LDAP entry
 * carried: `groups`, `department`, `title`, `email`, `employee_id`, `user`, or
 * anything an admin mapped — and how its value must compare. A department
 * matches when ANY rule holds (`mode: 'any'`) or when ALL do (`'all'`). No
 * rules → matches nobody, so a department only takes effect once configured.
 * Comparison is case-insensitive; `groups` values match on either the full DN
 * or the bare group name.
 */

export type RuleOp = 'is' | 'prefix' | 'contains';
export const RULE_OPS: RuleOp[] = ['is', 'prefix', 'contains'];

export interface DeptRule {
	attribute: string;
	op: RuleOp;
	value: string;
}

export type MatchMode = 'any' | 'all';

export interface DeptMatch {
	mode: MatchMode;
	rules: DeptRule[];
}

/** A person's sign-in claims, one list of values per attribute. */
export type ProfileClaims = Record<string, string[]>;

/** Attributes worth offering even before anyone with them has signed in. */
export const COMMON_ATTRIBUTES = ['groups', 'department', 'title', 'email', 'employee_id', 'user'];

export const EMPTY_MATCH: DeptMatch = { mode: 'any', rules: [] };

const MAX_RULES = 40;
const MAX_ATTR = 64;
const MAX_VALUE = 256;

export function ruleMatches(rule: DeptRule, claims: ProfileClaims): boolean {
	const want = rule.value.trim().toLowerCase();
	if (!want) return false;
	const values = claims[rule.attribute] ?? [];
	return values.some((raw) => {
		const have = raw.toLowerCase();
		switch (rule.op) {
			case 'is':
				return have === want;
			case 'prefix':
				return have.startsWith(want);
			case 'contains':
				return have.includes(want);
		}
	});
}

export function matchesDept(match: DeptMatch, claims: ProfileClaims): boolean {
	const rules = match.rules.filter((r) => r.attribute.trim() && r.value.trim());
	if (!rules.length) return false;
	return match.mode === 'all'
		? rules.every((r) => ruleMatches(r, claims))
		: rules.some((r) => ruleMatches(r, claims));
}

function str(v: unknown, max: number): string {
	return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/**
 * Coerce stored or submitted JSON into a well-formed match. Also reads the
 * pre-rules shape (`adGroups`, `costCenters`, `costCenterPrefix`) so existing
 * departments keep working: each old entry becomes an equivalent rule.
 */
export function sanitizeMatch(raw: unknown): DeptMatch {
	const m = typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : {};
	const rules: DeptRule[] = [];

	if (Array.isArray(m.rules)) {
		for (const r of m.rules) {
			if (typeof r !== 'object' || !r) continue;
			const rule = r as Record<string, unknown>;
			const attribute = str(rule.attribute, MAX_ATTR);
			const value = str(rule.value, MAX_VALUE);
			const op = RULE_OPS.includes(rule.op as RuleOp) ? (rule.op as RuleOp) : 'is';
			if (attribute && value) rules.push({ attribute, op, value });
		}
	}

	// Legacy shape.
	if (Array.isArray(m.adGroups)) {
		for (const g of m.adGroups) {
			const value = str(g, MAX_VALUE);
			if (value) rules.push({ attribute: 'groups', op: 'is', value });
		}
	}
	if (Array.isArray(m.costCenters)) {
		for (const c of m.costCenters) {
			const value = str(c, MAX_VALUE);
			if (value) rules.push({ attribute: 'cost_center', op: 'is', value });
		}
	}
	const prefix = str(m.costCenterPrefix, MAX_VALUE);
	if (prefix) rules.push({ attribute: 'cost_center', op: 'prefix', value: prefix });

	return {
		mode: m.mode === 'all' ? 'all' : 'any',
		rules: rules.slice(0, MAX_RULES)
	};
}

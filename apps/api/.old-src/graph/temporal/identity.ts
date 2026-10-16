// =============================================================================
// Relation identity: when two edges' props state the SAME fact (#353, #440, #445)
// =============================================================================
//
// The ONE comparison every caller shares — the insert planner (and through it
// #365's dedup "known, skipped" and closing stages) and #364's merge fold — so
// "is `{VP}` the same role as `{SVP}`?" can never get two different answers.
//
//   - `identityProps` (a relation's `required` props, HAS_ROLE.title) compare
//     strictly: strings trimmed and case-folded, absent ≡ null, null = null.
//   - `optionalIdentityProps` (its `identity: true` props, HAS_ROLE
//     .businessUnit) compare the same way, except that a null/absent value on
//     EITHER side matches anything — `{VP}` restates `{VP, "Supply Chain"}`.
//
// PURE: no Prisma, no Nest, no clock read.
// =============================================================================

import type { TemporalRule } from './types';

/** JSON with object keys sorted, so two equal JSON values stringify equally. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Identity comparison key: strings trimmed and case-folded; absent ≡ null. */
export function identityKey(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'string') return `s:${value.trim().toLowerCase()}`;
  return `j:${stableStringify(value)}`;
}

/** Whether two edges' props name the same fact under `rule`'s identity props. */
export function sameIdentityProps(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  rule: Pick<TemporalRule, 'identityProps' | 'optionalIdentityProps'>
): boolean {
  if (!rule.identityProps.every((k) => identityKey(a[k]) === identityKey(b[k]))) return false;
  // #440: an optional identity prop only distinguishes two facts when BOTH
  // state it — `{VP, null}` restates `{VP, "Supply Chain"}`, never contradicts it.
  return (rule.optionalIdentityProps ?? []).every((k) => {
    const x = identityKey(a[k]);
    const y = identityKey(b[k]);
    return x === 'null' || y === 'null' || x === y;
  });
}

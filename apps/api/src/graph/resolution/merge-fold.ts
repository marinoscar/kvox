// =============================================================================
// Which relations a merge folds together, and what the survivor inherits (#445)
// =============================================================================
//
// After a merge re-points the merged entity's relations onto the survivor, two
// rows may now say the same thing. They are folded — evidence moved onto the
// kept row, the duplicate tombstoned `merged` — ONLY when they are the same
// FACT: same type, same endpoints, same `valid` (the SQL candidate query
// decides those) AND the same identity props under the one shared rule
// (`sameIdentityProps`, the planner's and dedup's own comparison). So
// `Joe HAS_ROLE Microsoft {VP}` and `{SVP}` over the same period are two roles
// and both stay; `{VP}` and `{VP, Consulting}` are one role, and the survivor
// gains `businessUnit: Consulting` if it had none.
//
// A fill only ever adds a declared, non-deprecated prop the kept row lacks
// (null/absent) — it never overwrites a value — and is recorded so a reverse
// can take exactly that value back off.
//
// PURE: no Prisma, no Nest. The service fetches, this plans, the service writes.
// =============================================================================

import { ONTOLOGY, type OntologyRegistry } from '@app/shared/ontology';

import { identityKey, sameIdentityProps, temporalRuleFor, type TemporalRule } from '../temporal';

/** How one relation type decides "same fact" and which props a fold may copy. */
export interface FoldIdentity {
  /** `null` for a type this build does not know: every prop then compares strictly. */
  rule: Pick<TemporalRule, 'identityProps' | 'optionalIdentityProps'> | null;
  /** Declared, non-deprecated props a fold may copy onto the kept row, sorted. */
  fillableKeys: readonly string[];
}

export function relationFoldIdentity(type: string, registry: OntologyRegistry = ONTOLOGY): FoldIdentity {
  const spec = registry.relationType(type);
  if (!spec) return { rule: null, fillableKeys: [] };
  const rule = temporalRuleFor(spec);
  return {
    rule: {
      identityProps: rule.identityProps,
      ...(rule.optionalIdentityProps ? { optionalIdentityProps: rule.optionalIdentityProps } : {}),
    },
    fillableKeys: Object.keys(spec.props)
      .filter((k) => spec.props[k]?.deprecated === undefined)
      .sort(),
  };
}

export function asProps(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Same fact by props. An unknown type folds only on identical props (never loses data). */
export function sameRelationFact(a: Record<string, unknown>, b: Record<string, unknown>, identity: FoldIdentity): boolean {
  if (identity.rule === null) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => identityKey(a[k]) === identityKey(b[k]));
  }
  return sameIdentityProps(a, b, identity.rule);
}

/** The props the duplicate states and the kept row lacks — never an overwrite. */
export function propsToFill(
  duplicate: Record<string, unknown>,
  kept: Record<string, unknown>,
  fillableKeys: readonly string[],
): Record<string, unknown> {
  const fill: Record<string, unknown> = {};
  for (const k of fillableKeys) {
    if (identityKey(kept[k]) === 'null' && identityKey(duplicate[k]) !== 'null') fill[k] = duplicate[k];
  }
  return fill;
}

export interface FoldRelation {
  id: string;
  type: string;
  props: Record<string, unknown>;
  status: string;
}

/**
 * One re-pointed live relation and its live same-type/endpoints/`valid` rows,
 * in preference order (untouched rows first, then oldest, then id).
 */
export interface FoldGroup {
  relation: FoldRelation;
  candidates: Array<{ id: string; props: Record<string, unknown> }>;
}

export interface PlannedFold {
  relationId: string;
  keptId: string;
  previousStatus: string;
  /** Props copied onto the kept row; empty when it already stated everything. */
  filledProps: Record<string, unknown>;
}

/**
 * Plan the folds in relation-id order, exactly as the writes will apply them:
 * a relation folded earlier can no longer be anybody's kept row, and a kept
 * row's props include what an earlier fold already copied onto it.
 */
export function planRelationFolds(
  groups: readonly FoldGroup[],
  identityFor: (type: string) => FoldIdentity = (type) => relationFoldIdentity(type),
): PlannedFold[] {
  const retired = new Set<string>();
  const current = new Map<string, Record<string, unknown>>();
  const propsOf = (id: string, stored: Record<string, unknown>) => current.get(id) ?? stored;
  const plan: PlannedFold[] = [];
  for (const g of [...groups].sort((x, y) => (x.relation.id < y.relation.id ? -1 : x.relation.id > y.relation.id ? 1 : 0))) {
    const r = g.relation;
    if (retired.has(r.id)) continue;
    const identity = identityFor(r.type);
    const rProps = propsOf(r.id, r.props);
    for (const c of g.candidates) {
      if (c.id === r.id || retired.has(c.id)) continue;
      const kProps = propsOf(c.id, c.props);
      if (!sameRelationFact(rProps, kProps, identity)) continue;
      const filledProps = propsToFill(rProps, kProps, identity.fillableKeys);
      if (Object.keys(filledProps).length > 0) current.set(c.id, { ...kProps, ...filledProps });
      retired.add(r.id);
      plan.push({ relationId: r.id, keptId: c.id, previousStatus: r.status, filledProps });
      break;
    }
  }
  return plan;
}

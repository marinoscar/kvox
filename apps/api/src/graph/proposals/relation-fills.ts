// =============================================================================
// Prop enrichment of a `known` relation (#444; docs/specs/ontology.md §8)
// =============================================================================
//
// PURE. When #365's dedup stage matches a proposed relation to a live one
// (`dedup.verdict = 'known'`), the commit appends evidence to the stored edge —
// and, since #444, FILLS the props the new statement adds that the stored row
// does not carry yet: `{VP}` stored, `{VP, Consulting}` proposed → the stored
// row gains `businessUnit: 'Consulting'`.
//
// A fill is a proposed prop that is
//   (a) declared on the relation type in the owner's effective schema, and
//       not deprecated,
//   (b) present in the proposal (not null/absent/empty), and
//   (c) absent on the stored row (null/absent/empty).
// It NEVER overwrites: a differing non-null stored value stays as stored, with
// no conflict raised. An identity prop that differs cannot reach here — it
// makes a different fact, so dedup never calls the two `known`.
//
// The same function feeds the commit (what to write) and the proposal view
// (what the reviewer is shown the commit will add), so the two cannot
// disagree.
// =============================================================================

import type { EffectiveSchema } from '@app/shared/ontology';

type Json = Record<string, unknown>;

/** null, undefined, a blank string or an empty list — "nothing there". */
export function isAbsentPropValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * The props a `known` relation row would add to the stored relation. Keys in
 * the relation type's declared order; `{}` when there is nothing to add or
 * the type is unknown to the schema.
 */
export function relationFills(
  schema: Pick<EffectiveSchema, 'relationType'>,
  typeKey: string,
  proposed: Json,
  stored: Json,
): Json {
  const type = schema.relationType(typeKey);
  if (!type) return {};
  const out: Json = {};
  for (const prop of type.props) {
    if (prop.deprecated) continue;
    const value = proposed[prop.key];
    if (isAbsentPropValue(value)) continue;
    if (!isAbsentPropValue(stored[prop.key])) continue;
    out[prop.key] = value;
  }
  return out;
}

/**
 * The stored relation a row's `dedup` names when it is `known`, read
 * tolerantly from the effective payload — null for anything else.
 */
export function knownRelationTargetOf(effective: Json): string | null {
  const dedup = effective.dedup;
  if (dedup === null || typeof dedup !== 'object' || Array.isArray(dedup)) return null;
  const d = dedup as Json;
  return d.verdict === 'known' && typeof d.targetRelationId === 'string' ? d.targetRelationId : null;
}

/** `Business unit: Consulting` pieces, for the review row's subtitle. */
export function describeFills(schema: Pick<EffectiveSchema, 'relationType'> | null, typeKey: string, fills: Json): string | null {
  const keys = Object.keys(fills);
  if (keys.length === 0) return null;
  const props = schema?.relationType(typeKey)?.props ?? [];
  const parts = keys.map((key) => {
    const label = props.find((p) => p.key === key)?.label ?? key;
    const value = fills[key];
    const text = Array.isArray(value) ? value.map(String).join(', ') : String(value);
    return `${label}: ${text}`;
  });
  return `adds ${parts.join(', ')}`;
}

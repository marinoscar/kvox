// =============================================================================
// From an ontology relation type to the planner's rule (issue #353)
// =============================================================================

import type { EffectiveRelationType, RelationTypeSpec } from '@marinoscar/kvox-contract/ontology';
import type { TemporalRule } from './types.js';

/**
 * Build the planner's `TemporalRule` from an ontology relation type (#350).
 * `exclusiveScope` defaults to `'from'`; `identityProps` are the relation's
 * `required` props, sorted — HAS_ROLE → `['title']`, WORKS_FOR → `[]`;
 * `optionalIdentityProps` its `identity: true` props (#440), sorted — HAS_ROLE
 * → `['businessUnit']`, omitted when there are none.
 *
 * @stability experimental
 */
export function temporalRuleFor(
  relationType: Pick<RelationTypeSpec, 'temporal' | 'exclusive' | 'exclusiveScope' | 'props' | 'symmetric'>
): TemporalRule {
  const optional = Object.keys(relationType.props)
    .filter((key) => relationType.props[key]?.identity === true && relationType.props[key]?.required !== true)
    .sort();
  return {
    ...(relationType.symmetric === true ? { symmetric: true } : {}),
    temporal: relationType.temporal,
    exclusive: relationType.exclusive,
    exclusiveScope: relationType.exclusiveScope ?? 'from',
    identityProps: Object.keys(relationType.props)
      .filter((key) => relationType.props[key]?.required === true)
      .sort(),
    ...(optional.length > 0 ? { optionalIdentityProps: optional } : {}),
  };
}

/**
 * The planner's rule for a relation type as the caller's EFFECTIVE schema
 * declares it (`EffectiveSchema.relationType`). `identityProps` are the type's
 * REQUIRED props, sorted, and `optionalIdentityProps` its `identity: true`
 * props (#440) — the same derivation as {@link temporalRuleFor} (HAS_ROLE →
 * `['title']` and `['businessUnit']`). Shared by the proposal stages (#365)
 * and the manual relation edit (#586), so both apply one closing rule.
 *
 * @stability experimental
 */
export function ruleForEffectiveRelation(
  relation: Pick<EffectiveRelationType, 'temporal' | 'exclusive' | 'exclusiveScope' | 'props' | 'symmetric'>,
): TemporalRule {
  const optional = relation.props
    .filter((p) => p.identity === true && !p.required)
    .map((p) => p.key)
    .sort();
  return {
    // #383: the planner compares a symmetric relation in both directions.
    ...(relation.symmetric === true ? { symmetric: true } : {}),
    temporal: relation.temporal,
    exclusive: relation.exclusive,
    exclusiveScope: relation.exclusiveScope,
    identityProps: relation.props
      .filter((p) => p.required)
      .map((p) => p.key)
      .sort(),
    ...(optional.length > 0 ? { optionalIdentityProps: optional } : {}),
  };
}

/**
 * Closing (§5.4) applies to exactly the types declared `temporal: true, exclusive: 'soft'`.
 *
 * @stability experimental
 */
export function isExclusiveTemporal(rule: TemporalRule): boolean {
  return rule.temporal && rule.exclusive === 'soft';
}

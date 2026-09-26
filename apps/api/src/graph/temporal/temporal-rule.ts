// =============================================================================
// From an ontology relation type to the planner's rule (issue #353)
// =============================================================================

import type { RelationTypeSpec } from '@app/shared/ontology';
import type { TemporalRule } from './types';

/**
 * Build the planner's `TemporalRule` from an ontology relation type (#350).
 * `exclusiveScope` defaults to `'from'`; `identityProps` are the relation's
 * `required` props, sorted — HAS_ROLE → `['title']`, WORKS_FOR → `[]`.
 */
export function temporalRuleFor(
  relationType: Pick<RelationTypeSpec, 'temporal' | 'exclusive' | 'exclusiveScope' | 'props'>
): TemporalRule {
  return {
    temporal: relationType.temporal,
    exclusive: relationType.exclusive,
    exclusiveScope: relationType.exclusiveScope ?? 'from',
    identityProps: Object.keys(relationType.props)
      .filter((key) => relationType.props[key]?.required === true)
      .sort(),
  };
}

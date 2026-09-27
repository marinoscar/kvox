// =============================================================================
// Sensitivity filters for the Ask tools (#377; docs/specs/ontology.md §5.6, §14, §15)
// =============================================================================
//
// Enforced IN EVERY TOOL, never left to the prompt:
//
//   - `sensitive`: never returned by any tool, in any field, under any setting.
//     The read services already exclude sensitive PersonFacts; these helpers
//     re-check anyway (belt and braces), and they are the only filter for
//     attribute sensitivity, which no read service applies.
//   - `personal`: only when `ctx.personalFactsAllowed` (§14's opt-in).
//     Unclassified (`null`) is treated as personal — the §5.6 default, the same
//     rule `itemAllowedInPrompt` (brief-facts.ts) applies to the digest.
//   - `business`: always.
//   - #383: an entity or relation of a TYPE whose declared sensitivity is not
//     `business` (every `personal`-domain type — Interest, Trip, Milestone,
//     SPOUSE_OF, …) follows the same `personal` rule: returned only when
//     `ctx.personalFactsAllowed`. Enabling the `personal` domain decides which
//     types extraction offers; it is not consent to show them to a model.
// =============================================================================

import { ONTOLOGY } from '@app/shared/ontology';

import type { GraphPreferences } from '../../graph/preferences/graph-preferences.service';
import type { PrismaService } from '../../prisma/prisma.service';

/** Whether a value of this sensitivity may be returned to the agent. */
export function sensitivityVisible(sensitivity: string | null | undefined, personalFactsAllowed: boolean): boolean {
  if (sensitivity === 'sensitive') return false;
  if (sensitivity === 'business') return true;
  return personalFactsAllowed;
}

/** An item row: non-PersonFacts always pass; PersonFacts by their sensitivity. */
export function itemVisible(
  item: { kind: string; sensitivity?: string | null },
  personalFactsAllowed: boolean,
): boolean {
  if (item.kind !== 'person_fact') return true;
  return sensitivityVisible(item.sensitivity ?? null, personalFactsAllowed);
}

/**
 * Entity and relation type keys whose rows are personal by declaration (#383),
 * from the whole registry — not the caller's effective schema: rows written
 * while `personal` was enabled stay personal after it is turned off.
 */
export const PERSONAL_SENSITIVITY_TYPES: ReadonlySet<string> = new Set([
  ...ONTOLOGY.entityTypes()
    .filter((t) => t.itemKind === undefined && t.sensitivityDefault !== 'business')
    .map((t) => t.key),
  ...ONTOLOGY.relationTypes()
    .filter((r) => (r.sensitivityDefault ?? 'business') !== 'business')
    .map((r) => r.key),
]);

/** Whether an entity or relation of this type may be returned to the agent. */
export function typeVisible(type: string, personalFactsAllowed: boolean): boolean {
  return personalFactsAllowed || !PERSONAL_SENSITIVITY_TYPES.has(type);
}

/** The type keys a query must exclude (empty when personal facts are allowed). */
export function hiddenTypes(personalFactsAllowed: boolean): string[] {
  return personalFactsAllowed ? [] : [...PERSONAL_SENSITIVITY_TYPES];
}

/**
 * The §14 opt-in, resolved from the caller's graph preferences.
 *
 * ⚠ ALWAYS FALSE TODAY: #369's `graph` namespace has no personal-facts opt-in
 * yet (`domains.personal` enables the personal ontology domain — which types
 * exist — and is NOT consent to show personal facts to a model). When the
 * preference lands, this is the one line that reads it.
 */
export function personalFactsAllowedFor(_preferences: GraphPreferences): boolean {
  return false;
}

/**
 * `sensitivity` of the caller's own PersonFacts among `ids` (owner-scoped).
 * Ids that are not the caller's PersonFacts are absent from the map — callers
 * treat an absent id as "not visible".
 */
export async function personFactSensitivities(
  prisma: Pick<PrismaService, 'kgItem'>,
  ownerId: string,
  ids: readonly string[],
): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.kgItem.findMany({
    where: { ownerId, id: { in: [...new Set(ids)] }, kind: 'person_fact' },
    select: { id: true, sensitivity: true },
  });
  return new Map(rows.map((r) => [r.id, r.sensitivity]));
}

/** The subset of `ids` (PersonFact item ids) the agent may see. */
export async function visiblePersonFactIds(
  prisma: Pick<PrismaService, 'kgItem'>,
  ownerId: string,
  ids: readonly string[],
  personalFactsAllowed: boolean,
): Promise<Set<string>> {
  const map = await personFactSensitivities(prisma, ownerId, ids);
  return new Set([...map].filter(([, s]) => sensitivityVisible(s, personalFactsAllowed)).map(([id]) => id));
}

/**
 * Pure helpers for "Guide the graph" (#368, epic #346; ontology.md §6, §19).
 *
 * The dialog holds guidance in #363's `userGuidanceSchema` shape, where an
 * ABSENT `entityTypes`/`relationTypes` means "every type in your effective
 * ontology". `normalizeGuidance` is the one place that decides what is sent:
 * a list that names every offered type is omitted (so a type added to the
 * ontology later is extracted too), and guidance that says nothing at all is
 * omitted entirely.
 *
 * Pinned entities are stored as ids only (`pinnedEntityIds`), and there is no
 * `GET /api/graph/entities/:id` to turn one back into a name. So the labels a
 * user picked are remembered for the session (`rememberEntityLabel`), and a
 * proposal's own resolution candidates are consulted too; anything else is
 * rendered as "a pinned entity" rather than as a raw uuid.
 */

import type { GraphOntology, ProposalItem, UserGuidance } from '../../../services/graph';

export const EMPTY_GUIDANCE: UserGuidance = { pinnedEntityIds: [], instructions: '' };

/** Entity (and item) types a user may choose to extract. */
export function offeredEntityTypes(ontology: GraphOntology) {
  return ontology.entityTypes.filter((type) => !type.deprecated && type.extractable);
}

/** Relation types a user may choose to extract. */
export function offeredRelationTypes(ontology: GraphOntology) {
  return ontology.relationTypes.filter((type) => !type.deprecated && type.extractable);
}

function coversAll(selected: readonly string[] | undefined, offered: readonly string[]): boolean {
  if (selected === undefined) return true;
  return offered.every((key) => selected.includes(key));
}

/** What `POST …/extract` is sent: `undefined` when the guidance says nothing. */
export function normalizeGuidance(
  guidance: UserGuidance,
  ontology: GraphOntology | null,
): UserGuidance | undefined {
  const out: UserGuidance = {
    pinnedEntityIds: [...guidance.pinnedEntityIds],
    instructions: guidance.instructions.trim(),
  };
  const entityKeys = ontology ? offeredEntityTypes(ontology).map((type) => type.key) : [];
  const relationKeys = ontology ? offeredRelationTypes(ontology).map((type) => type.key) : [];
  if (guidance.entityTypes && !(ontology && coversAll(guidance.entityTypes, entityKeys))) {
    out.entityTypes = [...guidance.entityTypes];
  }
  if (guidance.relationTypes && !(ontology && coversAll(guidance.relationTypes, relationKeys))) {
    out.relationTypes = [...guidance.relationTypes];
  }
  const empty =
    out.pinnedEntityIds.length === 0 &&
    out.instructions === '' &&
    out.entityTypes === undefined &&
    out.relationTypes === undefined;
  return empty ? undefined : out;
}

/** True when the guidance narrows the run in any way. */
export function hasGuidance(guidance: UserGuidance | null | undefined): boolean {
  if (!guidance) return false;
  return (
    guidance.pinnedEntityIds.length > 0 ||
    guidance.instructions.trim() !== '' ||
    guidance.entityTypes !== undefined ||
    guidance.relationTypes !== undefined
  );
}

// -----------------------------------------------------------------------------
// Pinned entity labels
// -----------------------------------------------------------------------------

const labels = new Map<string, string>();

export function rememberEntityLabel(id: string, label: string): void {
  labels.set(id, label);
}

/** Test-only: forget every remembered label. */
export function forgetEntityLabels(): void {
  labels.clear();
}

/** The best name this session knows for an entity id, or null. */
export function entityLabel(id: string, items: readonly ProposalItem[] = []): string | null {
  const known = labels.get(id);
  if (known) return known;
  for (const item of items) {
    const resolution = item.resolution;
    if (!resolution) continue;
    if (resolution.ref === id && resolution.refLabel) return resolution.refLabel;
    const candidate = resolution.candidates.find((entry) => entry.entityId === id);
    if (candidate) return candidate.label;
  }
  return null;
}

/** "Focused on Sarah Chen, Q2 pilot · 3 types · instructions" — or null for no guidance. */
export function guidanceSummary(
  guidance: UserGuidance | null | undefined,
  items: readonly ProposalItem[] = [],
): string | null {
  if (!hasGuidance(guidance) || !guidance) return null;
  const parts: string[] = [];
  const pins = guidance.pinnedEntityIds;
  if (pins.length > 0) {
    const named = pins.map((id) => entityLabel(id, items)).filter((label): label is string => label !== null);
    const unnamed = pins.length - named.length;
    const shown = [...named];
    if (unnamed > 0) shown.push(`${unnamed} more`);
    parts.push(
      named.length > 0 ? `Focused on ${shown.join(', ')}` : `Focused on ${pins.length} ${pins.length === 1 ? 'entity' : 'entities'}`,
    );
  }
  if (guidance.entityTypes) {
    const n = guidance.entityTypes.length;
    parts.push(`${n} ${n === 1 ? 'type' : 'types'}`);
  }
  if (guidance.relationTypes) {
    const n = guidance.relationTypes.length;
    parts.push(`${n} ${n === 1 ? 'relationship' : 'relationships'}`);
  }
  if (guidance.instructions.trim() !== '') parts.push('instructions');
  return parts.join(' · ');
}

/**
 * Rows of a draft the USER has decided — what a re-extraction would throw
 * away. A row still at its extraction-time default (`prechecked` → accept,
 * otherwise pending) is the AI's decision, not the user's; a row the user
 * added is always theirs.
 */
export function userDecisionCount(items: readonly ProposalItem[]): number {
  return items.filter((item) => {
    if (item.origin === 'user') return true;
    const untouched = item.prechecked ? 'accept' : 'pending';
    return item.decision !== untouched;
  }).length;
}

/**
 * The questions the entity page's Ask panel suggests before a scoped
 * conversation has any messages (#381, spec `docs/specs/ontology.md` §21.5).
 *
 * Pure: built from the entity's own type and label, so a Person is offered
 * "What has Joe committed to?" and a Project "What's still open on Atlas?".
 * A type with no questions of its own (a Meeting, a user-defined type) gets
 * the one question every entity can answer.
 *
 * Clicking one ASKS it — the panel creates the scoped conversation and posts
 * the question in one go — exactly as `/ask`'s own suggestions do.
 */

export interface EntityAskSuggestionSubject {
  label: string;
  type: string;
}

type SuggestionBuilder = (label: string) => string[];

const BY_TYPE: Readonly<Record<string, SuggestionBuilder>> = {
  Person: (label) => [
    `What has ${label} committed to?`,
    `How has ${label}'s role changed?`,
    `What did we last discuss with ${label}?`,
  ],
  Organization: (label) => [
    `What's the latest on ${label}?`,
    `Which decisions involved ${label}?`,
    `Who do we work with at ${label}?`,
  ],
  Project: (label) => [
    `What's the status of ${label}?`,
    `What's still open on ${label}?`,
    `Which decisions changed ${label}?`,
  ],
};

const FALLBACK: SuggestionBuilder = (label) => [`What's the latest on ${label}?`];

/** The suggested questions for one entity, in display order. */
export function entityAskSuggestions(entity: EntityAskSuggestionSubject): string[] {
  const label = entity.label.trim() || 'this';
  const build = Object.prototype.hasOwnProperty.call(BY_TYPE, entity.type) ? BY_TYPE[entity.type] : FALLBACK;
  return build(label);
}

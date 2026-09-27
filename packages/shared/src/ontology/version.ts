// =============================================================================
// Ontology version and CHANGELOG (docs/specs/ontology.md §17.4).
//
// Semver on the definition: MAJOR when a type's meaning changes, MINOR when a
// type, relation or attribute is added, PATCH when only descriptions or
// extraction hints change. Every graph row records the version it was written
// against. Append a CHANGELOG entry with every bump; the last entry's version
// must equal ONTOLOGY_VERSION (the parity test pins it).
// =============================================================================

export interface OntologyChangelogEntry {
  version: string;
  /** YYYY-MM-DD */
  date: string;
  changes: string[];
}

export const CHANGELOG: readonly OntologyChangelogEntry[] = Object.freeze([
  Object.freeze({
    version: '1.0.0',
    date: '2026-09-26',
    changes: Object.freeze(['initial core + work']) as string[],
  }),
  Object.freeze({
    version: '1.0.1',
    date: '2026-09-26',
    changes: Object.freeze([
      'attribute alignment metadata: Person.title -> schema:jobTitle, Organization.website -> schema:url (#385)',
    ]) as string[],
  }),
  Object.freeze({
    version: '1.1.0',
    date: '2026-09-26',
    changes: Object.freeze([
      'personal domain: Interest, Trip, Milestone, SPOUSE_OF, PARENT_OF, FRIEND_OF, INTERESTED_IN, TRAVELED_ON, HAS_MILESTONE; relation `symmetric` flag',
      'relation `sensitivityDefault` (personal-domain relations are `personal`)',
    ]) as string[],
  }),
  Object.freeze({
    version: '1.2.0',
    date: '2026-09-27',
    changes: Object.freeze([
      'work: HAS_ROLE gains optional businessUnit; WORKS_FOR is the employer, HAS_ROLE the role/unit; Person.title deprecated in their favour (#440)',
    ]) as string[],
  }),
]);

export const ONTOLOGY_VERSION: string = '1.2.0';

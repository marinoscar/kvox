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
]);

export const ONTOLOGY_VERSION: string = '1.0.0';

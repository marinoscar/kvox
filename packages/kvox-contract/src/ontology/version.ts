// =============================================================================
// Ontology version and CHANGELOG (docs/specs/ontology.md §17.4).
//
// Semver on the definition: MAJOR when a type's meaning changes, MINOR when a
// type, relation or attribute is added, PATCH when only descriptions or
// extraction hints change. Every graph row records the version it was written
// against. Append a CHANGELOG entry with every bump; the last entry's version
// must equal ONTOLOGY_VERSION (the parity test pins it).
// =============================================================================

/**
 * The `OntologyChangelogEntry` shape (ontology changelog entry).
 *
 * @stability experimental
 */
export interface OntologyChangelogEntry {
  version: string;
  /** YYYY-MM-DD */
  date: string;
  changes: string[];
}

/**
 * Wire constant: changelog.
 *
 * @stability experimental
 */
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
      'relation prop `identity` flag: HAS_ROLE.businessUnit takes part in the role\'s identity (a unit change is a new role; an omitted unit matches any) (#440)',
    ]) as string[],
  }),
  Object.freeze({
    version: '1.3.0',
    date: '2026-10-21',
    changes: Object.freeze([
      'core: Topic entity type (skos:Concept) and BROADER relation (Topic -> Topic, skos:broader) (#662)',
      'work: Product entity type (schema:Product) with category and vendorName (#662)',
      'DISCUSSED widened to Meeting -> Project | Topic | Product | Organization; PART_OF gains Topic -> Project; Commitment and Decision subjectTypes gain Product and Topic (#662)',
      'work: stakeholder and market relations INVOLVED_IN (role, stance), USES (stage), OFFERED_BY, CUSTOMER_OF, PARTNER_OF, COMPETITOR_OF, CONCERNS, KNOWS_ABOUT (level) (#663)',
      'work: Risk item type (itemKind risk; open, mitigated, closed, superseded) with severity, riskKind and mitigation; SUPERSEDES allows Risk -> Risk (#664)',
    ]) as string[],
  }),
]);

/**
 * Wire constant: ontology version.
 *
 * @stability experimental
 */
export const ONTOLOGY_VERSION: string = '1.3.0';

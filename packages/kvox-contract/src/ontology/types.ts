// =============================================================================
// Ontology declaration types (docs/specs/ontology.md §17.1–§17.3).
//
// These describe what a domain module DECLARES. What a given user actually
// sees — types filtered to their enabled domains, mixins and their own
// attributes merged in — is the effective schema (`effective-schema.ts`).
// =============================================================================

import type {
  ATTRIBUTE_KINDS,
  DOMAIN_KEYS,
  ITEM_KINDS,
  PSEUDO_TYPES,
  SENSITIVITIES,
  VALID_PRECISIONS,
} from './constants.js';

/**
 * The `AttributeKind` type (attribute kind).
 *
 * @stability experimental
 */
export type AttributeKind = (typeof ATTRIBUTE_KINDS)[number];
/**
 * The `Sensitivity` type (sensitivity).
 *
 * @stability experimental
 */
export type Sensitivity = (typeof SENSITIVITIES)[number];
/**
 * The `ValidPrecision` type (valid precision).
 *
 * @stability experimental
 */
export type ValidPrecision = (typeof VALID_PRECISIONS)[number];
/**
 * The `KgItemKind` type (kg item kind).
 *
 * @stability experimental
 */
export type KgItemKind = (typeof ITEM_KINDS)[number];
/**
 * The `DomainKey` type (domain key).
 *
 * @stability experimental
 */
export type DomainKey = (typeof DOMAIN_KEYS)[number];
/**
 * The `PseudoType` type (pseudo type).
 *
 * @stability experimental
 */
export type PseudoType = (typeof PSEUDO_TYPES)[number];

/**
 * One choice of a `select` / `multi_select`. `value` is what is stored.
 *
 * @stability experimental
 */
export interface AttributeChoice {
  value: string;
  label: string;
}

/**
 * Per-kind options: choices for selects, target types for `entity_ref`.
 *
 * @stability experimental
 */
export interface AttributeOptions {
  choices?: AttributeChoice[];
  targetTypes?: string[];
}

/**
 * Marks a key retired. Keys are permanent (§17.1): deprecate, never delete.
 *
 * @stability experimental
 */
export interface Deprecation {
  since: string;
  reason: string;
}

/**
 * The `AttributeSpec` shape (attribute spec).
 *
 * @stability experimental
 */
export interface AttributeSpec {
  kind: AttributeKind;
  label: string;
  /** Used verbatim in the extraction prompt. */
  description: string;
  /**
   * Default false. A required attribute may never be null on write. On a
   * relation prop, `required` also makes the prop part of the relation's
   * identity (two edges with different values are different facts).
   */
  required?: boolean;
  /**
   * Relation props only; default false (#440). The prop participates in the
   * relation's identity like a `required` one, except that a null/absent value
   * matches anything: `{VP, "Supply Chain"}` and `{VP, "Finance"}` are two
   * facts, `{VP, null}` and `{VP, "Supply Chain"}` one (the first simply omits
   * the unit). Never on a `required` prop (already strict identity), a list,
   * or a `multi_select`.
   */
  identity?: boolean;
  /** Default false. When true the value is an array of `kind`. */
  list?: boolean;
  /** Default false. Only extractable attributes are ever asked of the model. */
  extractable?: boolean;
  /** Default: the owning type's `sensitivityDefault`. */
  sensitivity?: Sensitivity;
  options?: AttributeOptions;
  /**
   * A standard-vocabulary property this attribute is (§18.1), as a CURIE with
   * a prefix from `RDF_PREFIXES` — e.g. `schema:jobTitle`. When set, the RDF
   * generators use it as the attribute's IRI instead of `kv:<Type>.<key>`.
   * Metadata only: it never changes what is stored or validated.
   */
  alignment?: string;
  deprecated?: Deprecation;
}

/**
 * The `EntityTypeSpec` shape (entity type spec).
 *
 * @stability experimental
 */
export interface EntityTypeSpec {
  /** PascalCase and permanent once rows exist. */
  key: string;
  domain: DomainKey;
  label: string;
  pluralLabel: string;
  description: string;
  /** At least one rule against the type's nearest neighbour (§5.1). */
  disambiguation: string[];
  /** camelCase keys; never `u_*` (that prefix is reserved for user attributes). */
  attributes: Record<string, AttributeSpec>;
  sensitivityDefault: Sensitivity;
  /** e.g. `schema:Person` (§18). */
  alignment?: string;
  /** Presence means the type is stored in `kg_items`, not `kg_entities`. */
  itemKind?: KgItemKind;
  /** Item types only. */
  statuses?: readonly string[];
  /** Item types only: the types `kg_items.subject_id` may point at. */
  subjectTypes?: string[];
  /** Item types only. */
  subjectRequired?: boolean;
  /** Default true. False means created deterministically, never extracted (Meeting). */
  extractable?: boolean;
  deprecated?: Deprecation;
}

/**
 * How instances of a relation type are physically represented.
 *
 * @stability experimental
 */
export type RelationRepresentation =
  /** A `kg_relations` row. */
  | { kind: 'edge' }
  /** A column on the `kg_items` row itself. */
  | { kind: 'item_column'; column: 'subject_id' | 'owner_person_id' | 'counterparty_id' | 'meeting_id' }
  /** `kg_relations` with `from_speaker_id` (IDENTIFIED_AS). */
  | { kind: 'speaker_link' }
  /** `kg_mentions`. */
  | { kind: 'mention' }
  /** `kg_evidence`. */
  | { kind: 'evidence' }
  /** `superseded_by_id` columns. */
  | { kind: 'supersedes' };

/**
 * The `RelationTypeSpec` shape (relation type spec).
 *
 * @stability experimental
 */
export interface RelationTypeSpec {
  /** SCREAMING_SNAKE and permanent once rows exist. */
  key: string;
  domain: DomainKey;
  label: string;
  description: string;
  /** Entity type keys or PSEUDO_TYPES members. Never empty. */
  from: string[];
  to: string[];
  /** Narrows `from × to` to these pairs (PART_OF, SUPERSEDES). */
  allowedPairs?: [string, string][];
  temporal: boolean;
  /** `soft` requires `temporal` (§5.4: overlap warns, never rejects). */
  exclusive: 'soft' | 'none';
  /** Default `from`. HAS_ROLE is `from_to`: exclusive within one organization. */
  exclusiveScope?: 'from' | 'from_to';
  props: Record<string, AttributeSpec>;
  representation: RelationRepresentation;
  extractable: boolean;
  /**
   * Default false. True means `(a, b)` and `(b, a)` are the SAME fact
   * (SPOUSE_OF, FRIEND_OF): only one row is ever stored (§5.2), and dedup and
   * the "known, skipped" check compare both directions. Requires `from` and
   * `to` to be the same single type.
   */
  symmetric?: boolean;
  /**
   * Default `business`. The sensitivity an instance of this relation carries,
   * and the default for its props. Every `personal`-domain relation is
   * `personal`, so §15 applies to it (never pre-checked in review).
   */
  sensitivityDefault?: Sensitivity;
  alignment?: string;
  deprecated?: Deprecation;
}

/**
 * A domain's attributes added onto another domain's type (§17.2).
 *
 * @stability experimental
 */
export interface DomainMixin {
  entityType: string;
  attributes: Record<string, AttributeSpec>;
}

/**
 * The `DomainModule` shape (domain module).
 *
 * @stability experimental
 */
export interface DomainModule {
  key: DomainKey;
  label: string;
  alwaysOn: boolean;
  defaultEnabled: boolean;
  entityTypes: EntityTypeSpec[];
  relationTypes: RelationTypeSpec[];
  mixins: DomainMixin[];
}

/**
 * A user-defined attribute definition, as plain data. Mirrors a
 * `kg_attribute_defs` row; the API maps rows to this shape.
 *
 * @stability experimental
 */
export interface UserAttributeDef {
  id: string;
  entityType: string;
  /** `'u_' + [a-z0-9]{10}` */
  key: string;
  label: string;
  kind: AttributeKind;
  options: AttributeOptions | null;
  extractable: boolean;
  extractionHint: string | null;
  sensitivity: Sensitivity | null;
  sortOrder: number;
  /** ISO timestamp, or null while the attribute is live. */
  deprecatedAt: string | null;
}

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

export type AttributeKind = (typeof ATTRIBUTE_KINDS)[number];
export type Sensitivity = (typeof SENSITIVITIES)[number];
export type ValidPrecision = (typeof VALID_PRECISIONS)[number];
export type KgItemKind = (typeof ITEM_KINDS)[number];
export type DomainKey = (typeof DOMAIN_KEYS)[number];
export type PseudoType = (typeof PSEUDO_TYPES)[number];

/** One choice of a `select` / `multi_select`. `value` is what is stored. */
export interface AttributeChoice {
  value: string;
  label: string;
}

/** Per-kind options: choices for selects, target types for `entity_ref`. */
export interface AttributeOptions {
  choices?: AttributeChoice[];
  targetTypes?: string[];
}

/** Marks a key retired. Keys are permanent (§17.1): deprecate, never delete. */
export interface Deprecation {
  since: string;
  reason: string;
}

export interface AttributeSpec {
  kind: AttributeKind;
  label: string;
  /** Used verbatim in the extraction prompt. */
  description: string;
  /** Default false. A required attribute may never be null on write. */
  required?: boolean;
  /** Default false. When true the value is an array of `kind`. */
  list?: boolean;
  /** Default false. Only extractable attributes are ever asked of the model. */
  extractable?: boolean;
  /** Default: the owning type's `sensitivityDefault`. */
  sensitivity?: Sensitivity;
  options?: AttributeOptions;
  deprecated?: Deprecation;
}

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

/** How instances of a relation type are physically represented. */
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
  alignment?: string;
  deprecated?: Deprecation;
}

/** A domain's attributes added onto another domain's type (§17.2). */
export interface DomainMixin {
  entityType: string;
  attributes: Record<string, AttributeSpec>;
}

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

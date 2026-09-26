import type { ATTRIBUTE_KINDS, DOMAIN_KEYS, ITEM_KINDS, SENSITIVITIES, VALID_PRECISIONS } from './constants.js';
export type AttributeKind = (typeof ATTRIBUTE_KINDS)[number];
export type Sensitivity = (typeof SENSITIVITIES)[number];
export type ValidPrecision = (typeof VALID_PRECISIONS)[number];
export type KgItemKind = (typeof ITEM_KINDS)[number];
export type DomainKey = (typeof DOMAIN_KEYS)[number];
export interface AttributeChoice {
    value: string;
    label: string;
}
export interface AttributeOptions {
    /** `select` / `multi_select` only: the closed list of values. */
    choices?: AttributeChoice[];
    /** `entity_ref` only: the entity types the reference may point at. */
    targetTypes?: string[];
}
export interface DeprecationSpec {
    since: string;
    reason: string;
}
export interface AttributeSpec {
    kind: AttributeKind;
    label: string;
    /** Used verbatim in the extraction prompt. */
    description: string;
    /** Default false. */
    required?: boolean;
    /** Default false: when true the value is an array of `kind`. */
    list?: boolean;
    /** Default false. */
    extractable?: boolean;
    /** Default: the owning type's `sensitivityDefault`. */
    sensitivity?: Sensitivity;
    options?: AttributeOptions;
    deprecated?: DeprecationSpec;
}
export interface EntityTypeSpec {
    /** PascalCase, permanent once rows exist (§17.1). */
    key: string;
    domain: DomainKey;
    label: string;
    pluralLabel: string;
    description: string;
    /** At least one rule against the nearest neighbouring type (§5.1). */
    disambiguation: string[];
    /** Keys camelCase, never `u_*`. */
    attributes: Record<string, AttributeSpec>;
    sensitivityDefault: Sensitivity;
    /** e.g. `schema:Person` (§18). */
    alignment?: string;
    /** Presence means the type is stored in `kg_items`, not `kg_entities`. */
    itemKind?: KgItemKind;
    /** Item types only. */
    statuses?: readonly string[];
    /** Item types only: the types `kg_items.subject_id` may name. */
    subjectTypes?: string[];
    /** Item types only. */
    subjectRequired?: boolean;
    /** Default true; false means created deterministically (Meeting). */
    extractable?: boolean;
    deprecated?: DeprecationSpec;
}
export type RelationRepresentation = 
/** A `kg_relations` row. */
{
    kind: 'edge';
}
/** A column on the `kg_items` row itself. */
 | {
    kind: 'item_column';
    column: 'subject_id' | 'owner_person_id' | 'counterparty_id' | 'meeting_id';
}
/** `kg_relations` with `from_speaker_id` (IDENTIFIED_AS). */
 | {
    kind: 'speaker_link';
}
/** `kg_mentions`. */
 | {
    kind: 'mention';
}
/** `kg_evidence`. */
 | {
    kind: 'evidence';
}
/** `superseded_by_id` columns. */
 | {
    kind: 'supersedes';
};
export interface RelationTypeSpec {
    /** SCREAMING_SNAKE, permanent once rows exist (§17.1). */
    key: string;
    domain: DomainKey;
    label: string;
    description: string;
    /** Entity type keys or PSEUDO_TYPES. */
    from: string[];
    to: string[];
    /** Narrows `from x to` (PART_OF, SUPERSEDES). */
    allowedPairs?: [string, string][];
    temporal: boolean;
    /** `soft` requires `temporal` (§5.4's overlap tolerance). */
    exclusive: 'soft' | 'none';
    /** Default `from`; HAS_ROLE is `from_to` ("within one organization"). */
    exclusiveScope?: 'from' | 'from_to';
    props: Record<string, AttributeSpec>;
    representation: RelationRepresentation;
    extractable: boolean;
    alignment?: string;
    deprecated?: DeprecationSpec;
}
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
export interface OntologyRegistry {
    version: string;
    domains(): readonly DomainModule[];
    entityType(key: string): Readonly<EntityTypeSpec> | undefined;
    relationType(key: string): Readonly<RelationTypeSpec> | undefined;
    entityTypes(): readonly Readonly<EntityTypeSpec>[];
    relationTypes(): readonly Readonly<RelationTypeSpec>[];
}
/**
 * One `kg_attribute_defs` row as plain data (§17.3). #355 maps database rows
 * to this shape; this package never touches the database.
 */
export interface UserAttributeDef {
    id: string;
    entityType: string;
    /** `u_` + ten `[a-z0-9]`. */
    key: string;
    label: string;
    kind: AttributeKind;
    options: AttributeOptions | null;
    extractable: boolean;
    extractionHint: string | null;
    sensitivity: Sensitivity | null;
    sortOrder: number;
    /** ISO timestamp, or null when live. */
    deprecatedAt: string | null;
}
export interface EffectiveAttributePayload {
    key: string;
    label: string;
    kind: AttributeKind;
    required: boolean;
    list: boolean;
    options: AttributeOptions | null;
    extractable: boolean;
    /** Built-in: the declared description. User: the extraction hint (else the label). */
    description: string;
    sensitivity: Sensitivity;
    source: 'builtin' | 'mixin' | 'user';
    /** null for a user attribute. */
    domain: DomainKey | null;
    attributeDefId: string | null;
    deprecated: boolean;
    sortOrder: number;
}
export interface EffectiveEntityTypePayload {
    key: string;
    domain: DomainKey;
    label: string;
    pluralLabel: string;
    description: string;
    disambiguation: string[];
    storage: 'entity' | 'item';
    itemKind: KgItemKind | null;
    statuses: string[] | null;
    subjectTypes: string[] | null;
    subjectRequired: boolean;
    sensitivityDefault: Sensitivity;
    alignment: string | null;
    extractable: boolean;
    deprecated: boolean;
    attributes: EffectiveAttributePayload[];
}
export interface EffectiveRelationTypePayload {
    key: string;
    domain: DomainKey;
    label: string;
    description: string;
    from: string[];
    to: string[];
    allowedPairs: [string, string][] | null;
    temporal: boolean;
    exclusive: 'soft' | 'none';
    exclusiveScope: 'from' | 'from_to';
    representation: RelationRepresentation;
    extractable: boolean;
    alignment: string | null;
    deprecated: boolean;
    props: EffectiveAttributePayload[];
}
export interface EffectiveDomainPayload {
    key: DomainKey;
    label: string;
    enabled: boolean;
    alwaysOn: boolean;
}
/** Exactly what `GET /api/graph/ontology` (#354) returns. JSON-safe. */
export interface EffectiveSchemaPayload {
    version: string;
    domains: EffectiveDomainPayload[];
    entityTypes: EffectiveEntityTypePayload[];
    relationTypes: EffectiveRelationTypePayload[];
}
export type EffectiveAttribute = Readonly<EffectiveAttributePayload>;
export type EffectiveEntityType = Readonly<Omit<EffectiveEntityTypePayload, 'attributes'> & {
    attributes: readonly EffectiveAttribute[];
}>;
export type EffectiveRelationType = Readonly<Omit<EffectiveRelationTypePayload, 'props'> & {
    props: readonly EffectiveAttribute[];
}>;
/**
 * A caller's resolved ontology: types filtered to enabled domains (`core`
 * always), mixins merged, user attributes merged, relation endpoints pruned to
 * the types actually present. Deeply frozen. Not JSON-safe (it carries lookup
 * maps) -- `toEffectiveSchemaPayload()` is the wire form.
 */
export interface EffectiveSchema {
    readonly version: string;
    readonly domains: readonly Readonly<EffectiveDomainPayload>[];
    readonly enabledDomains: readonly DomainKey[];
    readonly entityTypes: readonly EffectiveEntityType[];
    readonly relationTypes: readonly EffectiveRelationType[];
    readonly entityTypeByKey: ReadonlyMap<string, EffectiveEntityType>;
    readonly relationTypeByKey: ReadonlyMap<string, EffectiveRelationType>;
}
export type PropsIssue = {
    path: string;
    message: string;
};
export type ValidatePropsResult = {
    ok: true;
    value: Record<string, unknown>;
} | {
    ok: false;
    issues: PropsIssue[];
};

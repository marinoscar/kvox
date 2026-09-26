import type { OntologyRegistry } from './registry.js';
import type { AttributeKind, AttributeOptions, DomainKey, KgItemKind, RelationRepresentation, Sensitivity, UserAttributeDef } from './types.js';
export interface EffectiveAttributePayload {
    key: string;
    label: string;
    kind: AttributeKind;
    required: boolean;
    list: boolean;
    options: AttributeOptions | null;
    extractable: boolean;
    /** Prompt copy. For a user attribute: its extraction hint, else its label. */
    description: string;
    sensitivity: Sensitivity;
    source: 'builtin' | 'mixin' | 'user';
    /** The declaring domain; null for a user attribute. */
    domain: DomainKey | null;
    attributeDefId: string | null;
    deprecated: boolean;
    sortOrder: number;
}
export interface EffectiveDomainPayload {
    key: DomainKey;
    label: string;
    enabled: boolean;
    alwaysOn: boolean;
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
export interface EffectiveSchemaPayload {
    version: string;
    domains: EffectiveDomainPayload[];
    entityTypes: EffectiveEntityTypePayload[];
    relationTypes: EffectiveRelationTypePayload[];
}
type DeepReadonly<T> = T extends (infer U)[] ? readonly DeepReadonly<U>[] : T extends object ? {
    readonly [K in keyof T]: DeepReadonly<T[K]>;
} : T;
export type EffectiveAttribute = DeepReadonly<EffectiveAttributePayload>;
export type EffectiveEntityType = DeepReadonly<EffectiveEntityTypePayload>;
export type EffectiveRelationType = DeepReadonly<EffectiveRelationTypePayload>;
/**
 * A resolved, deep-frozen view of one user's ontology. Build it with
 * `computeEffectiveSchema`; serialise it with `toEffectiveSchemaPayload`.
 */
export interface EffectiveSchema {
    readonly version: string;
    /** Registered domains in effect, in registry order; always includes `core`. */
    readonly enabledDomains: readonly DomainKey[];
    readonly domains: readonly DeepReadonly<EffectiveDomainPayload>[];
    readonly entityTypes: readonly EffectiveEntityType[];
    readonly relationTypes: readonly EffectiveRelationType[];
    entityType(key: string): EffectiveEntityType | undefined;
    relationType(key: string): EffectiveRelationType | undefined;
}
export interface ComputeEffectiveSchemaInput {
    /** The registry to resolve against. Defaults to `ONTOLOGY`. */
    registry?: OntologyRegistry;
    /** `core` (and any always-on domain) is forced in even if absent. */
    enabledDomains: readonly DomainKey[];
    userAttributes: readonly UserAttributeDef[];
}
/**
 * Resolve one user's effective schema. Throws `OntologyDefinitionError` on a
 * malformed user attribute def (bad key, kind, options, or a duplicate key on
 * one type). A def whose entity type is not present — its domain is disabled,
 * or the type is unknown — is left out, not an error: disabling a domain must
 * never break the endpoint.
 */
export declare function computeEffectiveSchemaFor(registry: OntologyRegistry, input: ComputeEffectiveSchemaInput): EffectiveSchema;
/**
 * The JSON-safe payload `GET /api/graph/ontology` returns: a fresh, mutable,
 * plain-data copy (`JSON.parse(JSON.stringify(p))` deep-equals it).
 */
export declare function toEffectiveSchemaPayload(schema: EffectiveSchema): EffectiveSchemaPayload;
export {};

import type { AttributeOptions, DomainModule, EntityTypeSpec, RelationTypeSpec } from './types.js';
/** Thrown for any ontology declaration that breaks a definition rule. */
export declare class OntologyDefinitionError extends Error {
    constructor(message: string);
}
/** Validates per-kind options; shared with user attribute defs. */
export declare function checkAttributeOptions(where: string, kind: string, options: AttributeOptions | null | undefined): void;
export declare function defineEntityType(spec: EntityTypeSpec): Readonly<EntityTypeSpec>;
export declare function defineRelationType(spec: RelationTypeSpec): Readonly<RelationTypeSpec>;
export declare function defineDomain(mod: DomainModule): Readonly<DomainModule>;

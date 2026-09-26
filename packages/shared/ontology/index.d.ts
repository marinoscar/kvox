export { ATTRIBUTE_KINDS, DEFAULT_ENABLED_DOMAINS, DOMAIN_KEYS, ITEM_KINDS, PSEUDO_TYPES, SENSITIVITIES, USER_ATTRIBUTE_KEY_PREFIX, VALID_PRECISIONS, } from './constants.js';
export type { AttributeChoice, AttributeKind, AttributeOptions, AttributeSpec, Deprecation, DomainKey, DomainMixin, DomainModule, EntityTypeSpec, KgItemKind, PseudoType, RelationRepresentation, RelationTypeSpec, Sensitivity, UserAttributeDef, ValidPrecision, } from './types.js';
export { defineDomain, defineEntityType, defineRelationType, OntologyDefinitionError } from './define.js';

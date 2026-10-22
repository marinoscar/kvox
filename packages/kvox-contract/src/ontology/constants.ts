// =============================================================================
// Ontology constants — the closed vocabularies every other file in this
// directory, and every consumer of `@app/shared/ontology`, is typed against.
// docs/specs/ontology.md §5 and §17.
// =============================================================================

/**
 * The kinds an attribute (built-in, mixin or user-defined) may take (§17.3).
 * Fixed: a new kind is a code change here, never a per-user option.
 *
 * @stability experimental
 */
export const ATTRIBUTE_KINDS = [
  'text',
  'number',
  'date',
  'boolean',
  'select',
  'multi_select',
  'url',
  'entity_ref',
] as const;

/**
 * §5.6. `sensitive` is never used in any prompt enrichment, under any setting.
 *
 * @stability experimental
 */
export const SENSITIVITIES = ['business', 'personal', 'sensitive'] as const;

/**
 * §5.4: how exact the source was about a `valid` range.
 *
 * @stability experimental
 */
export const VALID_PRECISIONS = ['day', 'month', 'year', 'unknown'] as const;

/**
 * The five item types stored in `kg_items` rather than `kg_entities`.
 *
 * @stability experimental
 */
export const ITEM_KINDS = ['commitment', 'decision', 'claim', 'person_fact', 'risk'] as const;

/**
 * Every domain key (§17.2). `personal` ships off by default (#383): a user
 * enables it through the `graph.domains.personal` preference.
 *
 * @stability experimental
 */
export const DOMAIN_KEYS = ['core', 'work', 'personal'] as const;

/**
 * Domains a user has enabled when they have never touched the setting.
 *
 * @stability experimental
 */
export const DEFAULT_ENABLED_DOMAINS = ['core', 'work'] as const;

/**
 * Relation endpoints that are not graph types: never `kg_entities` or
 * `kg_items` rows. Only `speaker_link`, `mention` and `evidence` relations may
 * name them.
 *
 * @stability experimental
 */
export const PSEUDO_TYPES = ['Speaker', 'Note', 'Transcript'] as const;

/**
 * Every user-defined attribute key starts with this, and no built-in key may.
 * That is what keeps the two namespaces from ever colliding in one `props`.
 *
 * @stability experimental
 */
export const USER_ATTRIBUTE_KEY_PREFIX = 'u_';

/**
 * Upper bound on any list / multi_select value.
 *
 * @stability experimental
 */
export const MAX_LIST_ITEMS = 50;
/**
 * Upper bound on a `text` value, after trimming.
 *
 * @stability experimental
 */
export const MAX_TEXT_LENGTH = 2000;
/**
 * Upper bound on a `url` value.
 *
 * @stability experimental
 */
export const MAX_URL_LENGTH = 2048;

/**
 * A user attribute key: the prefix plus exactly ten `[a-z0-9]`.
 *
 * @stability experimental
 */
export const USER_ATTRIBUTE_KEY_PATTERN = /^u_[a-z0-9]{10}$/;
/**
 * An entity/item type key: PascalCase, letters only.
 *
 * @stability experimental
 */
export const ENTITY_TYPE_KEY_PATTERN = /^[A-Z][A-Za-z]+$/;
/**
 * A relation type key: SCREAMING_SNAKE.
 *
 * @stability experimental
 */
export const RELATION_TYPE_KEY_PATTERN = /^[A-Z][A-Z_]+$/;
/**
 * A built-in attribute key: camelCase.
 *
 * @stability experimental
 */
export const ATTRIBUTE_KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;

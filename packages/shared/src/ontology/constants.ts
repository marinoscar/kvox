// =============================================================================
// Ontology constants — the closed vocabularies every other file in this
// directory, and every consumer of `@app/shared/ontology`, is typed against.
// docs/specs/ontology.md §5 and §17.
// =============================================================================

/**
 * The kinds an attribute (built-in, mixin or user-defined) may take (§17.3).
 * Fixed: a new kind is a code change here, never a per-user option.
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

/** §5.6. `sensitive` is never used in any prompt enrichment, under any setting. */
export const SENSITIVITIES = ['business', 'personal', 'sensitive'] as const;

/** §5.4: how exact the source was about a `valid` range. */
export const VALID_PRECISIONS = ['day', 'month', 'year', 'unknown'] as const;

/** The four item types stored in `kg_items` rather than `kg_entities`. */
export const ITEM_KINDS = ['commitment', 'decision', 'claim', 'person_fact'] as const;

/**
 * Every domain key (§17.2). `personal` is declared so settings and payloads can
 * name it, but no module ships for it yet.
 */
export const DOMAIN_KEYS = ['core', 'work', 'personal'] as const;

/** Domains a user has enabled when they have never touched the setting. */
export const DEFAULT_ENABLED_DOMAINS = ['core', 'work'] as const;

/**
 * Relation endpoints that are not graph types: never `kg_entities` or
 * `kg_items` rows. Only `speaker_link`, `mention` and `evidence` relations may
 * name them.
 */
export const PSEUDO_TYPES = ['Speaker', 'Note', 'Transcript'] as const;

/**
 * Every user-defined attribute key starts with this, and no built-in key may.
 * That is what keeps the two namespaces from ever colliding in one `props`.
 */
export const USER_ATTRIBUTE_KEY_PREFIX = 'u_';

/** Upper bound on any list / multi_select value. */
export const MAX_LIST_ITEMS = 50;
/** Upper bound on a `text` value, after trimming. */
export const MAX_TEXT_LENGTH = 2000;
/** Upper bound on a `url` value. */
export const MAX_URL_LENGTH = 2048;

/** A user attribute key: the prefix plus exactly ten `[a-z0-9]`. */
export const USER_ATTRIBUTE_KEY_PATTERN = /^u_[a-z0-9]{10}$/;
/** An entity/item type key: PascalCase, letters only. */
export const ENTITY_TYPE_KEY_PATTERN = /^[A-Z][A-Za-z]+$/;
/** A relation type key: SCREAMING_SNAKE. */
export const RELATION_TYPE_KEY_PATTERN = /^[A-Z][A-Z_]+$/;
/** A built-in attribute key: camelCase. */
export const ATTRIBUTE_KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;

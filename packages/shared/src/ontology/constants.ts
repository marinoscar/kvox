// =============================================================================
// Ontology constants (issue #350, epic #344, docs/specs/ontology.md §5, §17)
// =============================================================================
//
// Every closed list the ontology is built from. Declared `as const` so each
// one is simultaneously a runtime array (a Zod enum, a form's options) and the
// source of a TypeScript union (`types.ts`) -- one declaration, never two.
// =============================================================================

/** The fixed list an attribute's `kind` is drawn from (§17.3). */
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

/** §5.6. `sensitive` never enters any prompt enrichment, under any setting. */
export const SENSITIVITIES = ['business', 'personal', 'sensitive'] as const;

/** §5.4: how exact a `valid` range's source actually was. */
export const VALID_PRECISIONS = ['day', 'month', 'year', 'unknown'] as const;

/** The four kinds of `kg_items` row; each is claimed by exactly one item type. */
export const ITEM_KINDS = ['commitment', 'decision', 'claim', 'person_fact'] as const;

/**
 * Every domain key the ontology knows about (§17.2). `personal` is declared
 * so settings can name it, but no module ships for it yet (#383).
 */
export const DOMAIN_KEYS = ['core', 'work', 'personal'] as const;

/** The domains a user who never touched the settings card has enabled. */
export const DEFAULT_ENABLED_DOMAINS = ['core', 'work'] as const;

/**
 * Relation endpoints that are NOT `kg_entities` rows: a transcript's
 * diarized speaker, and the two content rows evidence points at. They may
 * appear only in `speaker_link`, `mention` and `evidence` relations.
 */
export const PSEUDO_TYPES = ['Speaker', 'Note', 'Transcript'] as const;

/**
 * Every user-defined attribute key starts with this prefix (§17.3), and no
 * built-in attribute key may -- so the two namespaces can never collide.
 */
export const USER_ATTRIBUTE_KEY_PREFIX = 'u_' as const;

/** The full shape of a user attribute key: the prefix plus ten `[a-z0-9]`. */
export const USER_ATTRIBUTE_KEY_PATTERN = /^u_[a-z0-9]{10}$/;

/** Upper bounds the props validators enforce (and the JSON Schema cannot). */
export const PROPS_LIMITS = {
  textMaxLength: 2000,
  urlMaxLength: 2048,
  listMaxItems: 50,
} as const;

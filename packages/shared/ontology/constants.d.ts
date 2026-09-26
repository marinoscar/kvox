/**
 * The kinds an attribute (built-in, mixin or user-defined) may take (§17.3).
 * Fixed: a new kind is a code change here, never a per-user option.
 */
export declare const ATTRIBUTE_KINDS: readonly ["text", "number", "date", "boolean", "select", "multi_select", "url", "entity_ref"];
/** §5.6. `sensitive` is never used in any prompt enrichment, under any setting. */
export declare const SENSITIVITIES: readonly ["business", "personal", "sensitive"];
/** §5.4: how exact the source was about a `valid` range. */
export declare const VALID_PRECISIONS: readonly ["day", "month", "year", "unknown"];
/** The four item types stored in `kg_items` rather than `kg_entities`. */
export declare const ITEM_KINDS: readonly ["commitment", "decision", "claim", "person_fact"];
/**
 * Every domain key (§17.2). `personal` is declared so settings and payloads can
 * name it, but no module ships for it yet.
 */
export declare const DOMAIN_KEYS: readonly ["core", "work", "personal"];
/** Domains a user has enabled when they have never touched the setting. */
export declare const DEFAULT_ENABLED_DOMAINS: readonly ["core", "work"];
/**
 * Relation endpoints that are not graph types: never `kg_entities` or
 * `kg_items` rows. Only `speaker_link`, `mention` and `evidence` relations may
 * name them.
 */
export declare const PSEUDO_TYPES: readonly ["Speaker", "Note", "Transcript"];
/**
 * Every user-defined attribute key starts with this, and no built-in key may.
 * That is what keeps the two namespaces from ever colliding in one `props`.
 */
export declare const USER_ATTRIBUTE_KEY_PREFIX = "u_";
/** Upper bound on any list / multi_select value. */
export declare const MAX_LIST_ITEMS = 50;
/** Upper bound on a `text` value, after trimming. */
export declare const MAX_TEXT_LENGTH = 2000;
/** Upper bound on a `url` value. */
export declare const MAX_URL_LENGTH = 2048;
/** A user attribute key: the prefix plus exactly ten `[a-z0-9]`. */
export declare const USER_ATTRIBUTE_KEY_PATTERN: RegExp;
/** An entity/item type key: PascalCase, letters only. */
export declare const ENTITY_TYPE_KEY_PATTERN: RegExp;
/** A relation type key: SCREAMING_SNAKE. */
export declare const RELATION_TYPE_KEY_PATTERN: RegExp;
/** A built-in attribute key: camelCase. */
export declare const ATTRIBUTE_KEY_PATTERN: RegExp;

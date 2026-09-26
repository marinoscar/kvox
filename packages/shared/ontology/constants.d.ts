/** The fixed list an attribute's `kind` is drawn from (§17.3). */
export declare const ATTRIBUTE_KINDS: readonly ["text", "number", "date", "boolean", "select", "multi_select", "url", "entity_ref"];
/** §5.6. `sensitive` never enters any prompt enrichment, under any setting. */
export declare const SENSITIVITIES: readonly ["business", "personal", "sensitive"];
/** §5.4: how exact a `valid` range's source actually was. */
export declare const VALID_PRECISIONS: readonly ["day", "month", "year", "unknown"];
/** The four kinds of `kg_items` row; each is claimed by exactly one item type. */
export declare const ITEM_KINDS: readonly ["commitment", "decision", "claim", "person_fact"];
/**
 * Every domain key the ontology knows about (§17.2). `personal` is declared
 * so settings can name it, but no module ships for it yet (#383).
 */
export declare const DOMAIN_KEYS: readonly ["core", "work", "personal"];
/** The domains a user who never touched the settings card has enabled. */
export declare const DEFAULT_ENABLED_DOMAINS: readonly ["core", "work"];
/**
 * Relation endpoints that are NOT `kg_entities` rows: a transcript's
 * diarized speaker, and the two content rows evidence points at. They may
 * appear only in `speaker_link`, `mention` and `evidence` relations.
 */
export declare const PSEUDO_TYPES: readonly ["Speaker", "Note", "Transcript"];
/**
 * Every user-defined attribute key starts with this prefix (§17.3), and no
 * built-in attribute key may -- so the two namespaces can never collide.
 */
export declare const USER_ATTRIBUTE_KEY_PREFIX: "u_";
/** The full shape of a user attribute key: the prefix plus ten `[a-z0-9]`. */
export declare const USER_ATTRIBUTE_KEY_PATTERN: RegExp;
/** Upper bounds the props validators enforce (and the JSON Schema cannot). */
export declare const PROPS_LIMITS: {
    readonly textMaxLength: 2000;
    readonly urlMaxLength: 2048;
    readonly listMaxItems: 50;
};

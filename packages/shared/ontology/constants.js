"use strict";
// =============================================================================
// Ontology constants — the closed vocabularies every other file in this
// directory, and every consumer of `@app/shared/ontology`, is typed against.
// docs/specs/ontology.md §5 and §17.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.ATTRIBUTE_KEY_PATTERN = exports.RELATION_TYPE_KEY_PATTERN = exports.ENTITY_TYPE_KEY_PATTERN = exports.USER_ATTRIBUTE_KEY_PATTERN = exports.MAX_URL_LENGTH = exports.MAX_TEXT_LENGTH = exports.MAX_LIST_ITEMS = exports.USER_ATTRIBUTE_KEY_PREFIX = exports.PSEUDO_TYPES = exports.DEFAULT_ENABLED_DOMAINS = exports.DOMAIN_KEYS = exports.ITEM_KINDS = exports.VALID_PRECISIONS = exports.SENSITIVITIES = exports.ATTRIBUTE_KINDS = void 0;
/**
 * The kinds an attribute (built-in, mixin or user-defined) may take (§17.3).
 * Fixed: a new kind is a code change here, never a per-user option.
 */
exports.ATTRIBUTE_KINDS = [
    'text',
    'number',
    'date',
    'boolean',
    'select',
    'multi_select',
    'url',
    'entity_ref',
];
/** §5.6. `sensitive` is never used in any prompt enrichment, under any setting. */
exports.SENSITIVITIES = ['business', 'personal', 'sensitive'];
/** §5.4: how exact the source was about a `valid` range. */
exports.VALID_PRECISIONS = ['day', 'month', 'year', 'unknown'];
/** The four item types stored in `kg_items` rather than `kg_entities`. */
exports.ITEM_KINDS = ['commitment', 'decision', 'claim', 'person_fact'];
/**
 * Every domain key (§17.2). `personal` is declared so settings and payloads can
 * name it, but no module ships for it yet.
 */
exports.DOMAIN_KEYS = ['core', 'work', 'personal'];
/** Domains a user has enabled when they have never touched the setting. */
exports.DEFAULT_ENABLED_DOMAINS = ['core', 'work'];
/**
 * Relation endpoints that are not graph types: never `kg_entities` or
 * `kg_items` rows. Only `speaker_link`, `mention` and `evidence` relations may
 * name them.
 */
exports.PSEUDO_TYPES = ['Speaker', 'Note', 'Transcript'];
/**
 * Every user-defined attribute key starts with this, and no built-in key may.
 * That is what keeps the two namespaces from ever colliding in one `props`.
 */
exports.USER_ATTRIBUTE_KEY_PREFIX = 'u_';
/** Upper bound on any list / multi_select value. */
exports.MAX_LIST_ITEMS = 50;
/** Upper bound on a `text` value, after trimming. */
exports.MAX_TEXT_LENGTH = 2000;
/** Upper bound on a `url` value. */
exports.MAX_URL_LENGTH = 2048;
/** A user attribute key: the prefix plus exactly ten `[a-z0-9]`. */
exports.USER_ATTRIBUTE_KEY_PATTERN = /^u_[a-z0-9]{10}$/;
/** An entity/item type key: PascalCase, letters only. */
exports.ENTITY_TYPE_KEY_PATTERN = /^[A-Z][A-Za-z]+$/;
/** A relation type key: SCREAMING_SNAKE. */
exports.RELATION_TYPE_KEY_PATTERN = /^[A-Z][A-Z_]+$/;
/** A built-in attribute key: camelCase. */
exports.ATTRIBUTE_KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;

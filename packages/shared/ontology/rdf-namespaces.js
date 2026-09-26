"use strict";
// =============================================================================
// RDF namespaces (docs/specs/ontology.md §2, §18.1; issue #385).
//
// Plain constants and two pure helpers — no RDF library. The OWL/RDFS and
// SHACL generators (`apps/api/src/graph/rdf/`) and the data export (#386) read
// every IRI prefix from here, so the vocabulary, the shapes and the exported
// data can never disagree about what `schema:` or `kv:` expands to.
//
// THE `kv:` NAMESPACE IS DERIVED FROM THE APPLICATION SLUG, NEVER SPELLED. The
// API passes `APP_SLUG` from `@app/shared`, so a renamed fork's export names
// its own namespace (and `apps/cli/src/template-identity.test.ts` keeps any
// product literal out of this file).
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.RDF_PREFIXES = exports.KV_PREFIX = void 0;
exports.kvNamespace = kvNamespace;
exports.expandCurie = expandCurie;
/** The prefix bound to the application's own namespace. */
exports.KV_PREFIX = 'kv';
/** A slug usable as a DNS label: lowercase letters, digits and inner hyphens. */
const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** The application's own namespace IRI, e.g. `https://<slug>.app/ns#`. */
function kvNamespace(appSlug) {
    if (typeof appSlug !== 'string' || !APP_SLUG_PATTERN.test(appSlug)) {
        throw new Error(`kvNamespace: '${String(appSlug)}' is not a lowercase hyphenated slug`);
    }
    return `https://${appSlug}.app/ns#`;
}
/**
 * The standard vocabularies the ontology aligns to, and the only prefixes an
 * `alignment` may use (the ontology parity test pins that).
 */
exports.RDF_PREFIXES = Object.freeze({
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    owl: 'http://www.w3.org/2002/07/owl#',
    xsd: 'http://www.w3.org/2001/XMLSchema#',
    sh: 'http://www.w3.org/ns/shacl#',
    prov: 'http://www.w3.org/ns/prov#',
    oa: 'http://www.w3.org/ns/oa#',
    schema: 'https://schema.org/',
    foaf: 'http://xmlns.com/foaf/0.1/',
    skos: 'http://www.w3.org/2004/02/skos/core#',
});
/** `prefix:local`, where the local part is a plain name. */
const CURIE_PATTERN = /^([a-z][a-z0-9]*):([A-Za-z_][A-Za-z0-9_-]*)$/;
/**
 * Expands a standard-vocabulary CURIE (`schema:jobTitle`) to its full IRI, or
 * `undefined` when the prefix is not one of `RDF_PREFIXES` or the CURIE is
 * malformed. `kv:` is deliberately not expandable here: it needs the slug.
 */
function expandCurie(curie) {
    if (typeof curie !== 'string')
        return undefined;
    const match = CURIE_PATTERN.exec(curie);
    if (match === null)
        return undefined;
    const [, prefix, local] = match;
    if (!Object.prototype.hasOwnProperty.call(exports.RDF_PREFIXES, prefix))
        return undefined;
    return `${exports.RDF_PREFIXES[prefix]}${local}`;
}

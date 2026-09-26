/** The prefix bound to the application's own namespace. */
export declare const KV_PREFIX = "kv";
/** The application's own namespace IRI, e.g. `https://<slug>.app/ns#`. */
export declare function kvNamespace(appSlug: string): string;
/**
 * The standard vocabularies the ontology aligns to, and the only prefixes an
 * `alignment` may use (the ontology parity test pins that).
 */
export declare const RDF_PREFIXES: Readonly<{
    readonly rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
    readonly rdfs: "http://www.w3.org/2000/01/rdf-schema#";
    readonly owl: "http://www.w3.org/2002/07/owl#";
    readonly xsd: "http://www.w3.org/2001/XMLSchema#";
    readonly sh: "http://www.w3.org/ns/shacl#";
    readonly prov: "http://www.w3.org/ns/prov#";
    readonly oa: "http://www.w3.org/ns/oa#";
    readonly schema: "https://schema.org/";
    readonly foaf: "http://xmlns.com/foaf/0.1/";
    readonly skos: "http://www.w3.org/2004/02/skos/core#";
}>;
export type RdfPrefix = keyof typeof RDF_PREFIXES;
/**
 * Expands a standard-vocabulary CURIE (`schema:jobTitle`) to its full IRI, or
 * `undefined` when the prefix is not one of `RDF_PREFIXES` or the CURIE is
 * malformed. `kv:` is deliberately not expandable here: it needs the slug.
 */
export declare function expandCurie(curie: string): string | undefined;

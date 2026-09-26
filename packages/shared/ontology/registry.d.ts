import type { DomainModule, OntologyRegistry } from './types.js';
/**
 * Builds a registry from domain modules. Throws `OntologyDefinitionError` on
 * a duplicate key, an unknown domain, or a dangling endpoint. Tests use it to
 * build deliberately broken registries; production code reads `ONTOLOGY`.
 */
export declare function buildOntologyRegistry(mods: DomainModule[], version: string): OntologyRegistry;
/** The shipped ontology: `core` + `work`. `personal` (#383) is one more line here. */
export declare const ONTOLOGY: OntologyRegistry;

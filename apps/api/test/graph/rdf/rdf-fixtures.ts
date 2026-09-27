import { Parser, type Quad } from 'n3';
import type { UserAttributeDef } from '@app/shared/ontology';

// =============================================================================
// Shared helpers for the ontology RDF tests (#385).
//
// `FIXTURE_NS` is the namespace every generator test and both .ttl fixtures
// use: `kvNamespace('fixture')`. A fixed slug, not `APP_SLUG`, so a snapshot
// and a hand-written fixture stay valid after a fork renames the app — the
// generators take the namespace as a parameter precisely so this works.
// =============================================================================

export const FIXTURE_NS = 'https://fixture.app/ns#';

export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
export const OWL = 'http://www.w3.org/2002/07/owl#';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const SH = 'http://www.w3.org/ns/shacl#';
export const PROV = 'http://www.w3.org/ns/prov#';
export const SCHEMA = 'https://schema.org/';

export const parseTurtle = (turtle: string): Quad[] => new Parser().parse(turtle);

/** Objects of `subject predicate ?o`. */
export function objectsOf(quads: readonly Quad[], subject: string, predicate: string): Quad['object'][] {
  return quads.filter((q) => q.subject.value === subject && q.predicate.value === predicate).map((q) => q.object);
}

/** Every subject with `rdf:type <type>`. */
export function subjectsOfType(quads: readonly Quad[], type: string): string[] {
  return quads
    .filter((q) => q.predicate.value === `${RDF}type` && q.object.value === type)
    .map((q) => q.subject.value);
}

/** The members of an RDF list, from its head node. */
export function listMembers(quads: readonly Quad[], head: string): Quad['object'][] {
  const out: Quad['object'][] = [];
  let node = head;
  while (node !== `${RDF}nil`) {
    const first = objectsOf(quads, node, `${RDF}first`)[0];
    if (first === undefined) throw new Error(`listMembers: ${node} is not a list node`);
    out.push(first);
    node = objectsOf(quads, node, `${RDF}rest`)[0].value;
  }
  return out;
}

/** The `sh:path` of every `sh:property` of one node shape. */
export function shapePaths(quads: readonly Quad[], shape: string): string[] {
  return objectsOf(quads, shape, `${SH}property`)
    .map((node) => objectsOf(quads, node.value, `${SH}path`)[0]?.value)
    .filter((path): path is string => path !== undefined);
}

/** The property shape node for one path of one node shape. */
export function propertyShape(quads: readonly Quad[], shape: string, path: string): string | undefined {
  return objectsOf(quads, shape, `${SH}property`).find(
    (node) => objectsOf(quads, node.value, `${SH}path`)[0]?.value === path,
  )?.value;
}

export function userDef(overrides: Partial<UserAttributeDef> & Pick<UserAttributeDef, 'id'>): UserAttributeDef {
  return {
    entityType: 'Person',
    key: 'u_abcdefghij',
    label: 'Nickname',
    kind: 'text',
    options: null,
    extractable: false,
    extractionHint: null,
    sensitivity: null,
    sortOrder: 0,
    deprecatedAt: null,
    ...overrides,
  };
}

/** Runs rdf-validate-shacl in a child process — see `shacl.ts`. */
export { validateShacl, type ShaclReport } from './shacl';

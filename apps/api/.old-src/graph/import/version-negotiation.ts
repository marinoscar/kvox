// =============================================================================
// Version negotiation for an import (#387, docs/specs/ontology.md §17.4, §18.3)
// =============================================================================
//
// Which ontology version the file was written against, and what to do about
// it — decided with #384's helpers (`compareOntologyVersions`,
// `migrationsBetween`), never a second semver implementation:
//
//   source version  `owl:versionInfo` on any `owl:Ontology` subject — or on the
//                   namespace IRI itself, which is where #386's export states
//                   it — else the most common `kv:ontologyVersion` literal,
//                   else "assume current" (`null` reported).
//   newer MAJOR     refuse (`ontology_version_newer`): a major bump means a
//                   type's meaning changed, and importing past it would read
//                   the data under the wrong definition. Upgrade first.
//   newer minor/patch, same version  → as is (validation catches anything unknown).
//   older           → the declared migrations between it and this build are
//                   applied to the triples IN MEMORY before validation
//                   (`migrateQuads`), and `migratedFrom` reports it when any
//                   migration applied.
//
// `migrateQuads` rewrites IRIs exactly as `applyMigrationSteps` rewrites rows:
// a retag renames the class (and its attribute IRIs) or the relation IRI (and
// every `rdf:predicate` naming it); an attribute rename renames the attribute
// IRI; a drop removes its triples; an item-status retag rewrites `kv:status`;
// a coercion re-types each value through `applyMigrationSteps` itself, so the
// file and a stored row are coerced by one implementation.
//
// ⚠ PURE. No Nest, no I/O, no RDF library.
// =============================================================================

import {
  applyMigrationSteps,
  compareOntologyVersions,
  isOntologyVersion,
  migrationsBetween,
  parseOntologyVersion,
  type OntologyMigration,
  type OntologyRegistry,
} from '@app/shared/ontology';

import { OWL, RDF, attributeIri, classIri, itemStatusIri, relationIri, relationPropIri } from '../rdf/iris';
import { kindDatatype, typeAttributes } from '../rdf/ontology-rdf-model';
import type { ImportQuad, ImportTerm } from './import-dataset';

const RDF_TYPE = `${RDF}type`;
const OWL_ONTOLOGY = `${OWL}Ontology`;
const OWL_VERSION_INFO = `${OWL}versionInfo`;

/** The version the file declares, or null when it declares none (validly). */
export function readSourceVersion(quads: readonly ImportQuad[], ns: string): string | null {
  const ontologies = new Set<string>([ns]);
  for (const q of quads) {
    if (q.p === RDF_TYPE && q.o.termType === 'NamedNode' && q.o.value === OWL_ONTOLOGY) ontologies.add(q.s.value);
  }
  for (const q of quads) {
    if (q.p === OWL_VERSION_INFO && q.s.termType === 'NamedNode' && ontologies.has(q.s.value) && isOntologyVersion(q.o.value)) {
      return q.o.value;
    }
  }
  const counts = new Map<string, number>();
  const versionIri = `${ns}ontologyVersion`;
  for (const q of quads) {
    if (q.p === versionIri && q.o.termType === 'Literal' && isOntologyVersion(q.o.value)) {
      counts.set(q.o.value, (counts.get(q.o.value) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [version, count] of [...counts.entries()].sort(([a], [b]) => compareOntologyVersions(a, b))) {
    if (count > bestCount) {
      best = version;
      bestCount = count;
    }
  }
  return best;
}

export type VersionDecision =
  | { kind: 'current' }
  | { kind: 'newer_major' }
  | { kind: 'newer_compatible' }
  | { kind: 'older'; migrations: OntologyMigration[] };

/** What to do with a file written at `source` in a deployment at `deployment`. */
export function negotiateVersion(
  source: string | null,
  deployment: string,
  migrations: readonly OntologyMigration[],
): VersionDecision {
  if (source === null || !isOntologyVersion(source)) return { kind: 'current' };
  const cmp = compareOntologyVersions(source, deployment);
  if (cmp === 0) return { kind: 'current' };
  if (cmp > 0) {
    return parseOntologyVersion(source)[0] > parseOntologyVersion(deployment)[0] ? { kind: 'newer_major' } : { kind: 'newer_compatible' };
  }
  return { kind: 'older', migrations: migrationsBetween(source, deployment, migrations) };
}

// -----------------------------------------------------------------------------
// In-memory migration of the triples
// -----------------------------------------------------------------------------

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Apply `migrations` (ascending) to the file's triples. Returns a new array. */
export function migrateQuads(
  quads: readonly ImportQuad[],
  ns: string,
  registry: OntologyRegistry,
  migrations: readonly OntologyMigration[],
): ImportQuad[] {
  let out: ImportQuad[] = quads.slice();
  const typeIri = (key: string) => safe(() => classIri(ns, key));
  // An attribute's IRI is its alignment when it declares one (`schema:jobTitle`),
  // exactly as the export writes it — for an entity/item type or a relation prop.
  const attrIri = (typeKey: string, key: string): string | undefined => {
    const type = registry.entityType(typeKey);
    if (type) {
      const spec = typeAttributes(registry, type).find((a) => a.key === key)?.spec;
      return safe(() => attributeIri(ns, typeKey, key, spec?.alignment));
    }
    const relation = registry.relationType(typeKey);
    if (relation) return safe(() => relationPropIri(ns, typeKey, key, relation.props[key]?.alignment));
    return safe(() => attributeIri(ns, typeKey, key));
  };
  for (const migration of migrations) {
    for (const step of migration.steps) {
      switch (step.op) {
        case 'retag_entity_type': {
          const from = typeIri(step.from);
          const to = typeIri(step.to);
          if (!from || !to) break;
          const attrPrefix = `${from}.`;
          out = out.map((q) => {
            let p = q.p;
            let o = q.o;
            if (q.p === RDF_TYPE && q.o.termType === 'NamedNode' && q.o.value === from) o = { termType: 'NamedNode', value: to };
            if (p.startsWith(attrPrefix)) p = `${to}.${p.slice(attrPrefix.length)}`;
            return p === q.p && o === q.o ? q : { s: q.s, p, o };
          });
          break;
        }
        case 'retag_relation_type': {
          const from = safe(() => relationIri(ns, step.from));
          const to = safe(() => relationIri(ns, step.to));
          if (!from || !to) break;
          const propPrefix = `${from}.`;
          out = out.map((q) => {
            let p = q.p;
            let o = q.o;
            if (p === from) p = to;
            else if (p.startsWith(propPrefix)) p = `${to}.${p.slice(propPrefix.length)}`;
            if (q.p === `${RDF}predicate` && q.o.termType === 'NamedNode' && q.o.value === from) o = { termType: 'NamedNode', value: to };
            return p === q.p && o === q.o ? q : { s: q.s, p, o };
          });
          break;
        }
        case 'rename_attribute': {
          const from = attrIri(step.typeKey, step.from);
          const to = attrIri(step.typeKey, step.to);
          if (!from || !to) break;
          out = out.map((q) => (q.p === from ? { s: q.s, p: to, o: q.o } : q));
          break;
        }
        case 'drop_attribute': {
          const iri = attrIri(step.typeKey, step.key);
          if (iri) out = out.filter((q) => q.p !== iri);
          break;
        }
        case 'retag_item_status': {
          const statusIri = itemStatusIri(ns);
          const itemType = registry.entityTypes().find((t) => t.itemKind === step.itemKind);
          const itemClass = itemType ? typeIri(itemType.key) : undefined;
          if (!itemClass) break;
          const ofKind = new Set(out.filter((q) => q.p === RDF_TYPE && q.o.value === itemClass).map((q) => q.s.value));
          out = out.map((q) =>
            q.p === statusIri && ofKind.has(q.s.value) && q.o.termType === 'Literal' && q.o.value === step.from
              ? { s: q.s, p: q.p, o: { ...q.o, value: step.to } }
              : q,
          );
          break;
        }
        case 'coerce_attribute': {
          const iri = attrIri(step.typeKey, step.key);
          if (!iri) break;
          const one: OntologyMigration = { ...migration, steps: [step] };
          const datatype = kindDatatype(step.to) ?? 'http://www.w3.org/2001/XMLSchema#string';
          out = out.flatMap((q): ImportQuad[] => {
            if (q.p !== iri || q.o.termType !== 'Literal') return [q];
            const r = applyMigrationSteps(
              { table: 'entity', type: step.typeKey, props: { [step.key]: literalValue(q.o) }, ontologyVersion: '0.0.0' },
              [one],
            );
            const value = r.row.props[step.key];
            if (value === undefined || value === null) return [];
            const values = Array.isArray(value) ? value : [value];
            return values.map((v) => ({ s: q.s, p: q.p, o: { termType: 'Literal', value: String(v), datatype } as ImportTerm }));
          });
          break;
        }
      }
    }
  }
  return out;
}

const NUMERIC = /#(decimal|integer|int|long|short|byte|double|float|nonNegativeInteger|positiveInteger|negativeInteger|nonPositiveInteger|unsignedInt|unsignedLong|unsignedShort|unsignedByte)$/;

/** A literal's JSON value, the way a stored `props` value would hold it. */
export function literalValue(term: ImportTerm): unknown {
  const dt = term.datatype ?? '';
  if (dt.endsWith('#boolean')) return term.value === 'true' || term.value === '1';
  if (NUMERIC.test(dt)) {
    const n = Number(term.value);
    return Number.isFinite(n) ? n : term.value;
  }
  return term.value;
}

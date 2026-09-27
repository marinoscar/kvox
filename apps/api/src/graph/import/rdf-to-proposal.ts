// =============================================================================
// Validated triples → proposal rows (#387, docs/specs/ontology.md §8, §18.1, §18.3)
// =============================================================================
//
// The inverse of #386's `GraphRdfDatasetBuilder`, onto EXACTLY #363's payload
// contract (`proposals/proposal-payload.schema.ts`) — one payload shape for
// every proposal kind, so #366's commit and #367's review sheet need no import
// branch. Runs only on a file that already passed SHACL, so a shape-level
// problem cannot reach here; what remains is deciding what each node becomes.
//
//   entity   a node typed `kv:<EntityType>` → `{ ref, type, label, aliases,
//            props, occurredAt }`. Label from `rdfs:label` (else the IRI's last
//            segment), aliases from `skos:altLabel`, props from every built-in
//            attribute IRI and the caller's own `kv:attr/<id>` definitions.
//   relation `kv:Assertion` reifications and direct `kv:<RELATION>` triples
//            between two entity nodes. A reified assertion WINS over the
//            direct triple it restates (its range, precision and props are the
//            complete statement); a direct triple no assertion covers becomes a
//            relation with no range. `kv:confidence` goes to `resolution.score`.
//   item     a node typed `kv:<ItemType>` → `{ ref, kind, title, statement,
//            subject, owner, counterparty, meeting, status, occurredAt, dueAt,
//            validFrom, validTo, precision, sensitivity, statementHash, props }`,
//            endpoints from its item-column relations.
//
// What is deliberately NOT imported:
//   - a `sensitive` person fact, and a value of a `sensitive` attribute
//     definition — never in bulk (§5.6); counted in `skippedSensitive`;
//   - a `superseded` item (`kv:reviewStatus "superseded"`): history, not a
//     live fact — importing it would assert something its own file says was
//     replaced;
//   - a Meeting's `transcriptId`/`noteId`: ids of ANOTHER deployment's rows;
//   - `entity_ref` attribute values (they name committed entities by id, which
//     a file from elsewhere cannot);
//   - speaker links (never exported) and evidence anchors — every row cites the
//     import itself (`evidenceFor`).
//
// REFS are proposal-local keys derived from the node key (`e`/`r`/`i` + 12 hex
// of its sha256), so the same file always maps to the same refs.
//
// ⚠ PURE. No Nest, no I/O, no RDF library.
// =============================================================================

import { createHash } from 'node:crypto';

import {
  VALID_PRECISIONS,
  type AttributeKind,
  type AttributeOptions,
  type EntityTypeSpec,
  type OntologyRegistry,
  type RelationTypeSpec,
  type UserAttributeDef,
  type ValidPrecision,
} from '@app/shared/ontology';

import type { EntityPayload, ItemPayload, ItemPayloadKind, ProposalResolution, RelationPayload } from '../proposals/proposal-payload.schema';
import { OA, PROV, RDF, RDFS, SKOS, annotationIri, attributeIri, dueAtIri, itemStatementIri, itemStatusIri, occurredAtIri, relationIri, relationPropIri, userAttributeIri } from '../rdf/iris';
import { isMultiValued, targetsFrom, typeAttributes } from '../rdf/ontology-rdf-model';
import { statementHash } from '../write/normalize';
import { indexBySubject, nodeKey, type ImportQuad, type ImportTerm } from './import-dataset';
import type { ImportVocabulary } from './import-vocabulary';

const RDF_TYPE = `${RDF}type`;
/** Longest evidence quote an import writes. */
export const IMPORT_QUOTE_MAX = 400;
const LABEL_MAX = 200;
const MAX_ALIASES = 10;
const STATEMENT_MAX = 2000;
/** Meeting attributes that hold another deployment's row ids. */
const DEPLOYMENT_LOCAL_PROPS: Readonly<Record<string, readonly string[]>> = { Meeting: ['transcriptId', 'noteId'] };
const COMMITMENT_STATUSES = ['open', 'done', 'dropped'] as const;

export interface ImportEvidence {
  sourceIri: string | null;
  quote: string;
}

export type ImportRow =
  | { kind: 'entity'; node: string; payload: EntityPayload; resolution: null; evidence: ImportEvidence }
  | { kind: 'relation'; node: string; payload: RelationPayload; resolution: ProposalResolution | null; evidence: ImportEvidence }
  | { kind: 'item'; node: string; payload: ItemPayload; resolution: null; evidence: ImportEvidence };

export interface ImportCounts {
  entities: number;
  relations: number;
  items: number;
  skippedSensitive: number;
}

export interface MapImportInput {
  quads: readonly ImportQuad[];
  ns: string;
  registry: OntologyRegistry;
  vocabulary: ImportVocabulary;
  /** The importing user's definitions (all of them — sensitive ones are skipped here). */
  userAttributes: readonly UserAttributeDef[];
  filename: string;
  /** Item node key → the file's `kv:sensitivity` (from the pre-pass). */
  sensitivity: ReadonlyMap<string, string>;
}

export interface MapImportResult {
  rows: ImportRow[];
  counts: ImportCounts;
}

// -----------------------------------------------------------------------------
// Small helpers (exported for tests)
// -----------------------------------------------------------------------------

export function refFor(prefix: 'e' | 'r' | 'i', key: string): string {
  return `${prefix}${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** `YYYY-MM-DD` from an `xsd:date` or `xsd:dateTime` lexical form, or null. */
export function isoDateOf(lexical: string | undefined): string | null {
  if (!lexical) return null;
  const m = DATE.exec(lexical);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The inclusive `validTo` a payload takes from an EXCLUSIVE upper bound (the
 * `valid` range's `upper`, which #386 writes as `prov:endedAtTime`): one unit
 * of the precision earlier. The commit adds the unit back (`rangeFromPrecision`).
 */
export function inclusiveEnd(exclusive: string, precision: 'day' | 'month' | 'year'): string | null {
  const m = DATE.exec(exclusive);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (precision === 'year') return `${y - 1}-01-01`;
  if (precision === 'month') return mo === 1 ? `${y - 1}-12-01` : `${y}-${pad(mo - 1)}-01`;
  const t = new Date(Date.UTC(y, mo - 1, d) - 86_400_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export interface PayloadTemporal {
  validFrom: string | null;
  validTo: string | null;
  precision: ValidPrecision;
}

/** `prov:startedAtTime`/`prov:endedAtTime` + `kv:validPrecision` → the payload's temporal fields. */
export function payloadTemporal(start: string | undefined, end: string | undefined, precisionRaw: string | undefined, temporal = true): PayloadTemporal {
  const none: PayloadTemporal = { validFrom: null, validTo: null, precision: 'unknown' };
  if (!temporal) return none;
  const from = isoDateOf(start);
  const hasEnd = isoDateOf(end) !== null;
  const precision: ValidPrecision = (VALID_PRECISIONS as readonly string[]).includes(precisionRaw ?? '')
    ? (precisionRaw as ValidPrecision)
    : from !== null || hasEnd
      ? 'day'
      : 'unknown';
  if (precision === 'unknown' || (from === null && !hasEnd)) return none;
  let validTo = hasEnd ? inclusiveEnd(end as string, precision) : null;
  if (validTo !== null && from !== null && validTo < from) validTo = from;
  return { validFrom: from, validTo, precision };
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function lastSegment(iri: string): string {
  const seg = iri.split(/[#/]/).filter((s) => s.length > 0).pop() ?? iri;
  return seg;
}

// -----------------------------------------------------------------------------
// The mapping
// -----------------------------------------------------------------------------

class Node {
  constructor(
    readonly key: string,
    readonly term: ImportTerm,
    readonly quads: readonly ImportQuad[],
  ) {}

  values(p: string): ImportTerm[] {
    return this.quads.filter((q) => q.p === p).map((q) => q.o);
  }

  literal(p: string): string | undefined {
    return this.quads.find((q) => q.p === p && q.o.termType === 'Literal')?.o.value;
  }
}

export function mapImportToProposal(input: MapImportInput): MapImportResult {
  const { ns, registry, vocabulary } = input;
  const bySubject = indexBySubject(input.quads);
  const nodes = new Map<string, Node>();
  for (const [key, quads] of bySubject) nodes.set(key, new Node(key, quads[0].s, quads));

  const typeOf = (node: Node): Readonly<EntityTypeSpec>[] =>
    node
      .values(RDF_TYPE)
      .map((t) => (t.termType === 'NamedNode' ? vocabulary.classes.get(t.value) : undefined))
      .filter((t): t is Readonly<EntityTypeSpec> => t !== undefined)
      .sort((a, b) => (a.key < b.key ? -1 : 1));
  const isAssertion = (node: Node) => node.values(RDF_TYPE).some((t) => t.value === vocabulary.assertionClass);

  const defsById = new Map(input.userAttributes.map((d) => [d.id.toLowerCase(), d]));
  const counts: ImportCounts = { entities: 0, relations: 0, items: 0, skippedSensitive: 0 };
  const rows: ImportRow[] = [];

  // --- evidence -----------------------------------------------------------------
  const evidenceFor = (node: Node): ImportEvidence => {
    const quotes: string[] = [];
    for (const target of node.values(`${PROV}wasDerivedFrom`)) {
      const key = nodeKey(target);
      const annotation = key ? nodes.get(key) : undefined;
      if (!annotation || !annotation.values(RDF_TYPE).some((t) => t.value === `${OA}Annotation`)) continue;
      for (const body of annotation.values(`${OA}hasBody`)) {
        const bodyKey = nodeKey(body);
        const value = bodyKey ? nodes.get(bodyKey)?.literal(`${RDF}value`) : body.termType === 'Literal' ? body.value : undefined;
        if (value && value.trim()) quotes.push(value.trim());
      }
    }
    const quote = quotes.length > 0 ? truncate([...new Set(quotes)].join(' … '), IMPORT_QUOTE_MAX) : truncate(`Imported from ${input.filename}`, IMPORT_QUOTE_MAX);
    const sourceIri = node.term.termType === 'NamedNode' && /^https?:\/\//.test(node.term.value) && node.term.value.length <= 2048 ? node.term.value : null;
    return { sourceIri, quote };
  };

  // --- attribute values -----------------------------------------------------------
  const scalar = (kind: AttributeKind, options: AttributeOptions | null | undefined, term: ImportTerm): unknown => {
    switch (kind) {
      case 'text':
        return term.termType === 'Literal' && term.value.length > 0 ? term.value : undefined;
      case 'select':
      case 'multi_select': {
        if (term.termType !== 'Literal') return undefined;
        const choices = options?.choices ?? [];
        return choices.length === 0 || choices.some((c) => c.value === term.value) ? term.value : undefined;
      }
      case 'number': {
        const n = Number(term.value);
        return term.termType === 'Literal' && term.value.trim() !== '' && Number.isFinite(n) ? n : undefined;
      }
      case 'date':
        return term.termType === 'Literal' ? (isoDateOf(term.value) ?? undefined) : undefined;
      case 'boolean':
        return term.termType === 'Literal' ? term.value === 'true' || term.value === '1' : undefined;
      case 'url':
        return /^https?:\/\//.test(term.value) ? term.value : undefined;
      case 'entity_ref':
        return undefined;
    }
  };
  const valueOf = (kind: AttributeKind, options: AttributeOptions | null | undefined, list: boolean | undefined, terms: ImportTerm[]): unknown => {
    const values = terms.map((t) => scalar(kind, options, t)).filter((v) => v !== undefined);
    if (values.length === 0) return undefined;
    return isMultiValued(kind, list) ? [...new Set(values)] : values[0];
  };
  const propsOf = (node: Node, type: Readonly<EntityTypeSpec>): Record<string, unknown> => {
    const props: Record<string, unknown> = {};
    const skip = new Set(DEPLOYMENT_LOCAL_PROPS[type.key] ?? []);
    for (const { key, spec } of typeAttributes(registry, type)) {
      if (skip.has(key)) continue;
      const terms = node.values(attributeIri(ns, type.key, key, spec.alignment));
      if (terms.length === 0) continue;
      if ((spec.sensitivity ?? type.sensitivityDefault) === 'sensitive') {
        counts.skippedSensitive += 1;
        continue;
      }
      const v = valueOf(spec.kind, spec.options, spec.list, terms);
      if (v !== undefined) props[key] = v;
    }
    for (const q of node.quads) {
      const prefix = `${ns}attr/`;
      if (!q.p.startsWith(prefix)) continue;
      const def = defsById.get(q.p.slice(prefix.length).toLowerCase());
      if (!def || def.entityType !== type.key || def.key in props) continue;
      if ((def.sensitivity ?? type.sensitivityDefault) === 'sensitive') {
        counts.skippedSensitive += 1;
        continue;
      }
      const v = valueOf(def.kind, def.options, false, node.values(userAttributeIri(ns, def.id)));
      if (v !== undefined) props[def.key] = v;
    }
    return props;
  };

  // --- entities -------------------------------------------------------------------
  const entityRef = new Map<string, string>();
  const entityType = new Map<string, string>();
  const refsUsed = new Set<string>();
  const uniqueRef = (prefix: 'e' | 'r' | 'i', key: string): string => {
    let ref = refFor(prefix, key);
    for (let n = 1; refsUsed.has(ref); n += 1) ref = refFor(prefix, `${key}#${n}`);
    refsUsed.add(ref);
    return ref;
  };

  for (const node of nodes.values()) {
    const type = typeOf(node).find((t) => t.itemKind === undefined);
    if (!type) continue;
    if (type.sensitivityDefault === 'sensitive') {
      counts.skippedSensitive += 1;
      continue;
    }
    const labelRaw = node.literal(`${RDFS}label`) ?? lastSegment(node.term.value);
    const label = truncate(labelRaw, LABEL_MAX) || lastSegment(node.term.value);
    const aliases = [
      ...new Set(
        node
          .values(`${SKOS}altLabel`)
          .filter((t) => t.termType === 'Literal')
          .map((t) => truncate(t.value, LABEL_MAX))
          .filter((a) => a.length > 0 && a !== label),
      ),
    ].slice(0, MAX_ALIASES);
    const ref = uniqueRef('e', node.key);
    entityRef.set(node.key, ref);
    entityType.set(node.key, type.key);
    rows.push({
      kind: 'entity',
      node: node.key,
      payload: { ref, type: type.key, label, aliases, props: propsOf(node, type), occurredAt: isoDateOf(node.literal(occurredAtIri(ns))) },
      resolution: null,
      evidence: evidenceFor(node),
    });
    counts.entities += 1;
  }

  // --- relations ------------------------------------------------------------------
  const edgeByIri = new Map<string, Readonly<RelationTypeSpec>>();
  for (const relation of registry.relationTypes()) {
    if (relation.representation.kind === 'edge') edgeByIri.set(relationIri(ns, relation.key), relation);
  }
  const allowedPair = (relation: Readonly<RelationTypeSpec>, fromKey: string, toKey: string): boolean => {
    const from = registry.entityType(entityType.get(fromKey) ?? '');
    const to = entityType.get(toKey);
    return from !== undefined && to !== undefined && targetsFrom(relation, from).includes(to);
  };
  const hasRequiredProps = (relation: Readonly<RelationTypeSpec>, props: Record<string, unknown>): boolean =>
    Object.entries(relation.props).every(([key, spec]) => spec.required !== true || props[key] !== undefined);

  const covered = new Set<string>();
  const pushRelation = (
    node: Node,
    relation: Readonly<RelationTypeSpec>,
    fromKey: string,
    toKey: string,
    temporal: PayloadTemporal,
    props: Record<string, unknown>,
    confidence: number | null,
    refKey: string,
  ) => {
    rows.push({
      kind: 'relation',
      node: node.key,
      payload: {
        ref: uniqueRef('r', refKey),
        type: relation.key,
        from: { ref: entityRef.get(fromKey) as string },
        to: { ref: entityRef.get(toKey) as string },
        props,
        ...temporal,
      },
      resolution: confidence === null ? null : { ref: null, score: confidence, source: null, candidates: [], adjudication: null },
      evidence: evidenceFor(node),
    });
    counts.relations += 1;
  };

  for (const node of nodes.values()) {
    if (!isAssertion(node)) continue;
    const s = node.values(`${RDF}subject`)[0];
    const p = node.values(`${RDF}predicate`)[0];
    const o = node.values(`${RDF}object`)[0];
    const relation = p ? edgeByIri.get(p.value) : undefined;
    const fromKey = s ? nodeKey(s) : null;
    const toKey = o ? nodeKey(o) : null;
    if (!relation || !fromKey || !toKey || !entityRef.has(fromKey) || !entityRef.has(toKey) || !allowedPair(relation, fromKey, toKey)) continue;
    const props: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(relation.props)) {
      if ((spec.sensitivity ?? relation.sensitivityDefault ?? 'business') === 'sensitive') continue;
      const v = valueOf(spec.kind, spec.options, spec.list, node.values(relationPropIri(ns, relation.key, key, spec.alignment)));
      if (v !== undefined) props[key] = v;
    }
    if (!hasRequiredProps(relation, props)) continue;
    const temporal = payloadTemporal(
      node.literal(`${PROV}startedAtTime`),
      node.literal(`${PROV}endedAtTime`),
      node.literal(annotationIri(ns, 'validPrecision')),
      relation.temporal,
    );
    const rawConfidence = node.literal(annotationIri(ns, 'confidence'));
    const confidence = rawConfidence !== undefined && Number.isFinite(Number(rawConfidence)) ? Math.min(1, Math.max(0, Number(rawConfidence))) : null;
    covered.add(`${fromKey}\u0000${relation.key}\u0000${toKey}`);
    pushRelation(node, relation, fromKey, toKey, temporal, props, confidence, node.key);
  }

  for (const node of nodes.values()) {
    if (!entityRef.has(node.key)) continue;
    for (const q of node.quads) {
      const relation = edgeByIri.get(q.p);
      const toKey = nodeKey(q.o);
      if (!relation || !toKey || !entityRef.has(toKey)) continue;
      if (covered.has(`${node.key}\u0000${relation.key}\u0000${toKey}`)) continue;
      if (!allowedPair(relation, node.key, toKey) || !hasRequiredProps(relation, {})) continue;
      covered.add(`${node.key}\u0000${relation.key}\u0000${toKey}`);
      pushRelation(node, relation, node.key, toKey, payloadTemporal(undefined, undefined, undefined, false), {}, null, `${node.key}\u0000${q.p}\u0000${toKey}`);
    }
  }

  // --- items ----------------------------------------------------------------------
  const columnField: Record<string, 'subject' | 'owner' | 'counterparty' | 'meeting'> = {
    subject_id: 'subject',
    owner_person_id: 'owner',
    counterparty_id: 'counterparty',
    meeting_id: 'meeting',
  };
  for (const node of nodes.values()) {
    const type = typeOf(node).find((t) => t.itemKind !== undefined);
    if (!type || type.itemKind === undefined) continue;
    if (node.literal(annotationIri(ns, 'reviewStatus')) === 'superseded') continue;
    const kind = type.itemKind as ItemPayloadKind;
    const sensitivity =
      kind === 'person_fact'
        ? ((['business', 'personal', 'sensitive'] as const).find((s) => s === input.sensitivity.get(node.key)) ??
          (type.sensitivityDefault as 'business' | 'personal' | 'sensitive'))
        : null;
    if (sensitivity === 'sensitive' || type.sensitivityDefault === 'sensitive') {
      counts.skippedSensitive += 1;
      continue;
    }
    const statementRaw = node.literal(itemStatementIri(ns, type.key));
    if (!statementRaw || !statementRaw.trim()) continue;
    const statement = truncate(statementRaw, STATEMENT_MAX);
    const title = truncate(node.literal(`${RDFS}label`) ?? statement, LABEL_MAX) || truncate(statement, LABEL_MAX);

    const endpoints: Record<'subject' | 'owner' | 'counterparty' | 'meeting', { ref: string } | null> = {
      subject: null,
      owner: null,
      counterparty: null,
      meeting: null,
    };
    for (const relation of registry.relationTypes()) {
      const rep = relation.representation;
      if (rep.kind !== 'item_column' || !relation.from.includes(type.key)) continue;
      const field = columnField[rep.column];
      if (!field) continue;
      const target = node.values(relationIri(ns, relation.key)).map(nodeKey).find((k) => k !== null && entityRef.has(k));
      if (target) endpoints[field] = { ref: entityRef.get(target) as string };
    }
    if ((type.subjectRequired === true || kind === 'claim' || kind === 'person_fact') && endpoints.subject === null) continue;

    const statusRaw = node.literal(itemStatusIri(ns));
    const status = kind === 'commitment' ? (COMMITMENT_STATUSES.find((s) => s === statusRaw) ?? null) : null;
    rows.push({
      kind: 'item',
      node: node.key,
      payload: {
        ref: uniqueRef('i', node.key),
        kind,
        title,
        statement,
        ...endpoints,
        status,
        occurredAt: isoDateOf(node.literal(occurredAtIri(ns))),
        dueAt: isoDateOf(node.literal(dueAtIri(ns))),
        ...payloadTemporal(node.literal(`${PROV}startedAtTime`), node.literal(`${PROV}endedAtTime`), node.literal(annotationIri(ns, 'validPrecision'))),
        sensitivity,
        statementHash: statementHash(kind, statement),
        props: propsOf(node, type),
      },
      resolution: null,
      evidence: evidenceFor(node),
    });
    counts.items += 1;
  }

  return { rows, counts };
}

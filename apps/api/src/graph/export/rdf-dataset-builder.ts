// =============================================================================
// GraphRdfDatasetBuilder — graph rows → RDF triples (issue #386,
// docs/specs/ontology.md §18.1, §18.2)
// =============================================================================
//
// The data half of the export. `kg.export` reads the owner's rows in pages and
// hands each row here; the builder answers with the triples that row becomes,
// grouped per subject, or `null` when the row must not leave the deployment.
// The serializers (`serializers.ts`) only turn those triples into bytes.
//
// EVERY IRI COMES FROM `rdf/iris.ts`, and every "may this row / value appear"
// decision is made against the SAME registry helpers the SHACL generator uses
// (`rdf/ontology-rdf-model.ts`). That is what "an export validates against its
// own shapes by construction" means in practice: the builder drops a value the
// shapes would reject (a select outside its choices, a URL that is not http(s),
// an edge between types the relation does not allow, an item whose required
// subject is not exported) rather than writing something invalid.
//
// ⚠ SENSITIVE NEVER LEAVES (§5.6, §15, §18.1) — AND IT IS DECIDED HERE, NOT IN
// A SERIALIZER. A `sensitive` PersonFact returns `null`; an attribute value
// whose (built-in or user) definition resolves to `sensitive` is dropped; both
// are counted in `stats.excludedSensitive`. Evidence whose subject is a
// sensitive item is dropped too — its quote is the fact.
//
// What each row becomes (§18.1):
//
//   entity    kv:entity/<id> a kv:<Type>, <alignment>; rdfs:label; attribute
//             values; skos:altLabel per alias; kv:occurredAt; kv:reviewStatus;
//             kv:ontologyVersion; prov:wasDerivedFrom kv:evidence/<id>…; and the
//             direct triple of every outgoing exported edge (plus its aligned
//             property), so each subject's triples stay together
//   item      kv:item/<id> a kv:<ItemType>; rdfs:label (title);
//             kv:<ItemType>.statement; kv:status; kv:occurredAt; kv:dueAt;
//             prov:startedAtTime/endedAtTime + kv:validPrecision (its `valid`);
//             kv:ABOUT/ASSIGNED_TO/OWED_TO/CREATED_IN/DECIDED_IN from its
//             columns; kv:SUPERSEDES + prov:wasRevisionOf the items it replaced
//   relation  kv:relation/<id> a kv:Assertion; rdf:subject/predicate/object;
//             finite prov:startedAtTime/endedAtTime; kv:validPrecision; props;
//             kv:confidence; kv:reviewStatus; prov:wasDerivedFrom … — EVERY
//             exported edge is reified, because the reified node is the only
//             place an edge's citations can live (RDF-star is not emitted).
//             A symmetric relation (#383: SPOUSE_OF, FRIEND_OF) is stored once,
//             in whichever direction it was written, and exported exactly as
//             stored — one direct triple, one assertion, never a mirrored
//             inverse: `owl:SymmetricProperty` in the vocabulary says (b, a)
//             follows, so writing it too would state one fact twice
//   evidence  kv:evidence/<id> a oa:Annotation; oa:hasBody [ rdf:value quote ];
//             oa:hasTarget [ oa:hasSource kv:segment/<id> | kv:note/<id>/v<n>;
//             oa:hasSelector FragmentSelector "t=<s>,<e>" and/or
//             TextPositionSelector oa:start/oa:end ]
//
// DETERMINISTIC. Blank nodes are labelled from the evidence id; triples inside
// a block are sorted (rdf:type first, then by predicate IRI, then object), and
// blank-node triples follow their subject's, sorted by label.
//
// ⚠ PURE. No Nest, no I/O, no RDF library (§18.4) — plain data in, plain data out.
// =============================================================================

import {
  PSEUDO_TYPES,
  type AttributeKind,
  type AttributeOptions,
  type EntityTypeSpec,
  type OntologyRegistry,
  type RelationTypeSpec,
  type Sensitivity,
  type UserAttributeDef,
} from '@app/shared/ontology';

import {
  OA,
  OWL,
  PROV,
  RDF,
  RDFS,
  SKOS,
  XSD,
  alignmentIri,
  annotationIri,
  assertionClassIri,
  attributeIri,
  classIri,
  dueAtIri,
  entityIri,
  evidenceIri,
  exportIri,
  itemIri,
  itemStatementIri,
  itemStatusIri,
  noteSpanIri,
  occurredAtIri,
  relationInstanceIri,
  relationIri,
  relationPropIri,
  segmentIri,
  userAttributeIri,
} from '../rdf/iris';
import {
  describedUserAttributes,
  isExportedRelation,
  isMultiValued,
  itemTypeForKind,
  kindDatatype,
  targetsFrom,
  typeAttributes,
} from '../rdf/ontology-rdf-model';
import { URL_PATTERN } from '../rdf/shacl-generator';

// -----------------------------------------------------------------------------
// Terms
// -----------------------------------------------------------------------------

export interface NamedNodeTerm {
  readonly termType: 'NamedNode';
  readonly value: string;
}
export interface BlankNodeTerm {
  readonly termType: 'BlankNode';
  readonly value: string;
}
export interface LiteralTerm {
  readonly termType: 'Literal';
  readonly value: string;
  /** Always set; `xsd:string` for a plain string. */
  readonly datatype: string;
}
export type RdfTerm = NamedNodeTerm | BlankNodeTerm | LiteralTerm;

export interface RdfTriple {
  readonly subject: NamedNodeTerm | BlankNodeTerm;
  readonly predicate: NamedNodeTerm;
  readonly object: RdfTerm;
}

/** One subject's triples, plus those of the blank nodes only it points at. */
export interface RdfSubjectBlock {
  readonly subject: string;
  readonly triples: readonly RdfTriple[];
}

const named = (value: string): NamedNodeTerm => ({ termType: 'NamedNode', value });
const blank = (value: string): BlankNodeTerm => ({ termType: 'BlankNode', value });
const lit = (value: string, datatype = `${XSD}string`): LiteralTerm => ({ termType: 'Literal', value, datatype });
const dateTime = (d: Date): LiteralTerm => lit(d.toISOString(), `${XSD}dateTime`);

const RDF_TYPE = `${RDF}type`;
const XSD_STRING = `${XSD}string`;

// -----------------------------------------------------------------------------
// Rows (plain data, read by the handler)
// -----------------------------------------------------------------------------

/** A relation as both the entity pass (direct triple) and the relation pass (reified node) see it. */
export interface ExportRelationRow {
  id: string;
  type: string;
  fromId: string;
  fromType: string;
  toId: string;
  toType: string;
  props: unknown;
  validFrom: Date | null;
  validTo: Date | null;
  validPrecision: string | null;
  reviewStatus: string;
  confidence: number | null;
  ontologyVersion: string;
}

export interface ExportEntityRow {
  id: string;
  type: string;
  label: string;
  props: unknown;
  reviewStatus: string;
  occurredAt: Date | null;
  ontologyVersion: string;
  aliases: readonly string[];
  evidenceIds: readonly string[];
  /** Exported (readable) entities this row's `entity_ref` values name → their type. */
  refTypes: ReadonlyMap<string, string>;
  /** Readable outgoing edges, for the direct triples. */
  outgoing: readonly ExportRelationRow[];
}

/** An exported (readable) entity an item column points at. */
export interface ExportEntityRef {
  id: string;
  type: string;
}

export interface ExportItemRow {
  id: string;
  kind: string;
  title: string | null;
  statement: string;
  status: string;
  props: unknown;
  occurredAt: Date | null;
  dueAt: Date | null;
  validFrom: Date | null;
  validTo: Date | null;
  validPrecision: string | null;
  reviewStatus: string;
  confidence: number | null;
  sensitivity: string | null;
  ontologyVersion: string;
  /** Column targets that are exported; `null` when unset or not readable. */
  subject: ExportEntityRef | null;
  meeting: ExportEntityRef | null;
  ownerPerson: ExportEntityRef | null;
  counterparty: ExportEntityRef | null;
  /** Exported items whose `superseded_by_id` is this item. */
  supersedes: ReadonlyArray<{ id: string; kind: string }>;
  evidenceIds: readonly string[];
  /** Exported entities this item's `entity_ref` values name → their type. */
  refTypes: ReadonlyMap<string, string>;
}

export interface ExportRelationNodeRow extends ExportRelationRow {
  evidenceIds: readonly string[];
}

export interface ExportEvidenceRow {
  id: string;
  subjectKind: string;
  /** The subject item's sensitivity, for item evidence. */
  subjectSensitivity: string | null;
  quote: string;
  segmentId: string | null;
  startMs: number | null;
  endMs: number | null;
  noteId: string | null;
  noteVersion: number | null;
  charStart: number | null;
  charEnd: number | null;
}

export interface GraphExportStats {
  entities: number;
  relations: number;
  items: number;
  evidence: number;
  excludedSensitive: number;
}

export interface GraphRdfDatasetBuilderOptions {
  ns: string;
  registry: OntologyRegistry;
  /** ALL of the owner's definitions, sensitive included — the builder filters. */
  attributeDefs: readonly UserAttributeDef[];
  exportId: string;
  generatedAt: Date;
  ontologyVersion: string;
}

// -----------------------------------------------------------------------------
// Value helpers (pure, exported for tests)
// -----------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = new RegExp(URL_PATTERN);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A finite number in `xsd:decimal` lexical form (never exponent notation). */
export function decimalLexical(n: number): string | null {
  if (!Number.isFinite(n)) return null;
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

/** `t=<start>,<end>` in seconds (W3C Media Fragments), from milliseconds. */
export function mediaFragment(startMs: number, endMs: number): string {
  return `t=${decimalLexical(startMs / 1000)},${decimalLexical(endMs / 1000)}`;
}

/** Sorts a subject block's triples deterministically. */
function sortTriples(subject: string, triples: RdfTriple[]): RdfTriple[] {
  const key = (t: RdfTriple): string => {
    const o = t.object;
    const obj = o.termType === 'Literal' ? `L${o.value}\u0000${o.datatype}` : `${o.termType[0]}${o.value}`;
    return `${t.predicate.value === RDF_TYPE ? '0' : '1'}${t.predicate.value}\u0000${obj}`;
  };
  const seen = new Set<string>();
  const main: Array<[string, RdfTriple]> = [];
  const bnodes: Array<[string, RdfTriple]> = [];
  for (const t of triples) {
    const k = `${t.subject.termType}${t.subject.value}\u0000${key(t)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (t.subject.termType === 'NamedNode' && t.subject.value === subject) main.push([key(t), t]);
    else bnodes.push([`${t.subject.value}\u0000${key(t)}`, t]);
  }
  const cmp = (a: [string, RdfTriple], b: [string, RdfTriple]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return [...main.sort(cmp), ...bnodes.sort(cmp)].map(([, t]) => t);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const isPseudo = (key: string) => (PSEUDO_TYPES as readonly string[]).includes(key);

// -----------------------------------------------------------------------------
// The builder
// -----------------------------------------------------------------------------

interface ValueRules {
  kind: AttributeKind;
  options?: AttributeOptions | null;
  list?: boolean;
}

export class GraphRdfDatasetBuilder {
  readonly stats: GraphExportStats = { entities: 0, relations: 0, items: 0, evidence: 0, excludedSensitive: 0 };

  private readonly ns: string;
  private readonly registry: OntologyRegistry;
  /** `${entityType}\u0000${key}` → definition, every definition the owner has. */
  private readonly userDefs = new Map<string, UserAttributeDef>();
  /** Ids of the definitions the shapes describe (non-sensitive, known type). */
  private readonly describedDefIds: ReadonlySet<string>;

  constructor(private readonly options: GraphRdfDatasetBuilderOptions) {
    this.ns = options.ns;
    this.registry = options.registry;
    for (const def of options.attributeDefs) this.userDefs.set(`${def.entityType}\u0000${def.key}`, def);
    this.describedDefIds = new Set(describedUserAttributes(options.registry, options.attributeDefs).map((d) => d.id));
  }

  // ---------------------------------------------------------------------------
  // Header
  // ---------------------------------------------------------------------------

  /** `<ns> owl:versionInfo` — sorts before every other subject in the namespace. */
  ontologyHeader(): RdfSubjectBlock {
    const s = named(this.ns);
    return { subject: this.ns, triples: [{ subject: s, predicate: named(`${OWL}versionInfo`), object: lit(this.options.ontologyVersion) }] };
  }

  /**
   * `kv:export/<id>` — the export document: when it was generated and against
   * which ontology version. No `dcterms:creator`: nothing about the account
   * holder is written.
   */
  exportHeader(): RdfSubjectBlock {
    const subject = exportIri(this.ns, this.options.exportId);
    const s = named(subject);
    return {
      subject,
      triples: sortTriples(subject, [
        { subject: s, predicate: named(RDF_TYPE), object: named(`${PROV}Entity`) },
        { subject: s, predicate: named(`${PROV}generatedAtTime`), object: dateTime(this.options.generatedAt) },
        { subject: s, predicate: named(annotationIri(this.ns, 'ontologyVersion')), object: lit(this.options.ontologyVersion) },
      ]),
    };
  }

  /** The owner's non-sensitive attribute definitions: `kv:attr/<id> a owl:DatatypeProperty; rdfs:label`. */
  attributeDefinitions(): RdfSubjectBlock[] {
    return describedUserAttributes(this.registry, this.options.attributeDefs).map((def) => {
      const subject = userAttributeIri(this.ns, def.id);
      const s = named(subject);
      return {
        subject,
        triples: sortTriples(subject, [
          {
            subject: s,
            predicate: named(RDF_TYPE),
            object: named(def.kind === 'entity_ref' ? `${OWL}ObjectProperty` : `${OWL}DatatypeProperty`),
          },
          { subject: s, predicate: named(`${RDFS}label`), object: lit(def.label) },
        ]),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Entities
  // ---------------------------------------------------------------------------

  entity(row: ExportEntityRow): RdfSubjectBlock | null {
    const type = this.registry.entityType(row.type);
    if (type === undefined || type.itemKind !== undefined) return null;
    // A type whose default is `sensitive` never leaves (none ships today; the
    // personal domain is `personal`, which IS exported).
    if (type.sensitivityDefault === 'sensitive') {
      this.stats.excludedSensitive += 1;
      return null;
    }
    if (row.evidenceIds.length === 0) return null;

    const subject = entityIri(this.ns, row.id);
    const s = named(subject);
    const out: RdfTriple[] = [];
    const add = (predicate: string, object: RdfTerm) => out.push({ subject: s, predicate: named(predicate), object });

    add(RDF_TYPE, named(classIri(this.ns, type.key)));
    if (type.alignment !== undefined) add(RDF_TYPE, named(alignmentIri(type.alignment)));
    add(`${RDFS}label`, lit(row.label));
    for (const alias of row.aliases) if (alias !== row.label && alias.length > 0) add(`${SKOS}altLabel`, lit(alias));
    if (row.occurredAt !== null) add(occurredAtIri(this.ns), dateTime(row.occurredAt));
    this.common(add, row.reviewStatus, null, row.ontologyVersion, row.evidenceIds);
    this.attributeValues(type, row.props, row.refTypes, add);

    for (const rel of row.outgoing) {
      if (rel.fromId !== row.id) continue;
      const relation = this.exportableRelation(rel);
      if (relation === undefined) continue;
      const to = named(entityIri(this.ns, rel.toId));
      add(relationIri(this.ns, relation.key), to);
      if (relation.alignment !== undefined) add(alignmentIri(relation.alignment), to);
    }

    this.stats.entities += 1;
    return { subject, triples: sortTriples(subject, out) };
  }

  // ---------------------------------------------------------------------------
  // Items
  // ---------------------------------------------------------------------------

  item(row: ExportItemRow): RdfSubjectBlock | null {
    const type = itemTypeForKind(this.registry, row.kind);
    if (type === undefined) return null;

    // ⚠ §5.6/§15/§18.1: a sensitive fact never leaves the deployment.
    if (row.sensitivity === 'sensitive' || (row.sensitivity === null && type.sensitivityDefault === 'sensitive')) {
      this.stats.excludedSensitive += 1;
      return null;
    }
    if (row.evidenceIds.length === 0) return null;

    const subject = itemIri(this.ns, row.id);
    const s = named(subject);
    const out: RdfTriple[] = [];
    const add = (predicate: string, object: RdfTerm) => out.push({ subject: s, predicate: named(predicate), object });

    // Item-column relations: exactly the ones the registry declares from this type.
    const columnTargets: Record<string, ExportEntityRef | null> = {
      subject_id: row.subject,
      meeting_id: row.meeting,
      owner_person_id: row.ownerPerson,
      counterparty_id: row.counterparty,
    };
    for (const relation of this.registry.relationTypes()) {
      const rep = relation.representation;
      if (rep.kind !== 'item_column' || !relation.from.includes(type.key)) continue;
      const target = columnTargets[rep.column];
      const allowed = target !== null && targetsFrom(relation, type).includes(target.type);
      if (allowed) add(relationIri(this.ns, relation.key), named(entityIri(this.ns, target.id)));
      // A required subject that is not exported would leave the item invalid: skip the item.
      else if (rep.column === 'subject_id' && type.subjectRequired === true) return null;
    }

    add(RDF_TYPE, named(classIri(this.ns, type.key)));
    if (type.alignment !== undefined) add(RDF_TYPE, named(alignmentIri(type.alignment)));
    if (row.title !== null && row.title.trim().length > 0) add(`${RDFS}label`, lit(row.title));
    add(itemStatementIri(this.ns, type.key), lit(row.statement));
    if (type.statuses?.includes(row.status)) add(itemStatusIri(this.ns), lit(row.status));
    if (row.occurredAt !== null) add(occurredAtIri(this.ns), dateTime(row.occurredAt));
    if (row.dueAt !== null) add(dueAtIri(this.ns), dateTime(row.dueAt));
    this.validRange(add, row);
    this.common(add, row.reviewStatus, row.confidence, row.ontologyVersion, row.evidenceIds);
    this.attributeValues(type, row.props, row.refTypes, add);

    // SUPERSEDES: this (newer) item replaced each of these — also PROV's revision.
    const supersedes = this.registry.relationTypes().find((r) => r.representation.kind === 'supersedes');
    if (supersedes !== undefined && isExportedRelation(supersedes)) {
      const allowed = targetsFrom(supersedes, type);
      for (const older of row.supersedes) {
        const olderType = itemTypeForKind(this.registry, older.kind);
        if (olderType === undefined || !allowed.includes(olderType.key)) continue;
        const target = named(itemIri(this.ns, older.id));
        add(relationIri(this.ns, supersedes.key), target);
        add(`${PROV}wasRevisionOf`, target);
      }
    }

    this.stats.items += 1;
    return { subject, triples: sortTriples(subject, out) };
  }

  // ---------------------------------------------------------------------------
  // Relations (the reified node)
  // ---------------------------------------------------------------------------

  relation(row: ExportRelationNodeRow): RdfSubjectBlock | null {
    const relation = this.exportableRelation(row);
    if (relation === undefined || row.evidenceIds.length === 0) return null;

    const subject = relationInstanceIri(this.ns, row.id);
    const s = named(subject);
    const out: RdfTriple[] = [];
    const add = (predicate: string, object: RdfTerm) => out.push({ subject: s, predicate: named(predicate), object });

    add(RDF_TYPE, named(assertionClassIri(this.ns)));
    add(`${RDF}subject`, named(entityIri(this.ns, row.fromId)));
    add(`${RDF}predicate`, named(relationIri(this.ns, relation.key)));
    add(`${RDF}object`, named(entityIri(this.ns, row.toId)));
    this.validRange(add, row);
    this.common(add, row.reviewStatus, row.confidence, row.ontologyVersion, row.evidenceIds);

    const props = asRecord(row.props);
    for (const [key, spec] of Object.entries(relation.props)) {
      if (!(key in props)) continue;
      // A relation prop defaults to its relation type's sensitivity (#383).
      if (this.isSensitive(spec.sensitivity, relation.sensitivityDefault ?? 'business')) {
        this.stats.excludedSensitive += 1;
        continue;
      }
      const terms = this.valueTerms({ kind: spec.kind, options: spec.options, list: spec.list }, props[key], new Map());
      for (const term of terms) add(relationPropIri(this.ns, relation.key, key, spec.alignment), term);
    }

    this.stats.relations += 1;
    return { subject, triples: sortTriples(subject, out) };
  }

  // ---------------------------------------------------------------------------
  // Evidence
  // ---------------------------------------------------------------------------

  evidence(row: ExportEvidenceRow): RdfSubjectBlock | null {
    // ⚠ Evidence for a sensitive fact IS the fact: its quote never leaves either.
    if (row.subjectKind === 'item' && row.subjectSensitivity === 'sensitive') return null;
    if (row.subjectKind !== 'entity' && row.subjectKind !== 'relation' && row.subjectKind !== 'item') return null;

    const subject = evidenceIri(this.ns, row.id);
    const s = named(subject);
    const label = row.id.toLowerCase().replace(/-/g, '');
    const body = blank(`ev${label}b`);
    const out: RdfTriple[] = [
      { subject: s, predicate: named(RDF_TYPE), object: named(`${OA}Annotation`) },
      { subject: s, predicate: named(`${OA}hasBody`), object: body },
      { subject: body, predicate: named(`${RDF}value`), object: lit(row.quote) },
    ];

    let source: string | null = null;
    if (row.segmentId !== null && UUID.test(row.segmentId)) source = segmentIri(this.ns, row.segmentId);
    else if (row.noteId !== null && row.noteVersion !== null && row.noteVersion >= 1) {
      source = noteSpanIri(this.ns, row.noteId, row.noteVersion);
    }

    if (source !== null) {
      const target = blank(`ev${label}t`);
      out.push({ subject: s, predicate: named(`${OA}hasTarget`), object: target });
      out.push({ subject: target, predicate: named(`${OA}hasSource`), object: named(source) });
      if (row.segmentId !== null && row.startMs !== null && row.endMs !== null && row.endMs >= row.startMs) {
        const selector = blank(`ev${label}f`);
        out.push({ subject: target, predicate: named(`${OA}hasSelector`), object: selector });
        out.push({ subject: selector, predicate: named(RDF_TYPE), object: named(`${OA}FragmentSelector`) });
        out.push({ subject: selector, predicate: named(`${RDF}value`), object: lit(mediaFragment(row.startMs, row.endMs)) });
      }
      if (row.charStart !== null && row.charEnd !== null && row.charStart >= 0 && row.charEnd >= row.charStart) {
        const selector = blank(`ev${label}p`);
        out.push({ subject: target, predicate: named(`${OA}hasSelector`), object: selector });
        out.push({ subject: selector, predicate: named(RDF_TYPE), object: named(`${OA}TextPositionSelector`) });
        out.push({ subject: selector, predicate: named(`${OA}start`), object: lit(String(row.charStart), `${XSD}nonNegativeInteger`) });
        out.push({ subject: selector, predicate: named(`${OA}end`), object: lit(String(row.charEnd), `${XSD}nonNegativeInteger`) });
      }
    }

    this.stats.evidence += 1;
    return { subject, triples: sortTriples(subject, out) };
  }

  /** `kv:segment/<id> rdfs:label "<transcript title>"` — only for a still-readable source. */
  segmentLabel(segmentId: string, title: string): RdfSubjectBlock {
    return this.labelBlock(segmentIri(this.ns, segmentId), title);
  }

  /** `kv:note/<id>/v<n> rdfs:label "<note title>"` — only for a still-readable note. */
  noteSpanLabel(noteId: string, version: number, title: string): RdfSubjectBlock {
    return this.labelBlock(noteSpanIri(this.ns, noteId, version), title);
  }

  // ---------------------------------------------------------------------------
  // Shared
  // ---------------------------------------------------------------------------

  /**
   * The relation spec for an edge row when the edge may be exported: an exported
   * `edge` relation, between two types the relation allows, carrying every
   * required prop. The entity pass and the relation pass both ask this, so a
   * direct triple and its reified node are always written together or not at all.
   */
  exportableRelation(row: ExportRelationRow): Readonly<RelationTypeSpec> | undefined {
    const relation = this.registry.relationType(row.type);
    if (relation === undefined || relation.representation.kind !== 'edge' || !isExportedRelation(relation)) return undefined;
    const from = this.registry.entityType(row.fromType);
    if (from === undefined || from.itemKind !== undefined || isPseudo(row.toType)) return undefined;
    const to = this.registry.entityType(row.toType);
    if (to === undefined || to.itemKind !== undefined) return undefined;
    if (!targetsFrom(relation, from).includes(to.key)) return undefined;
    const props = asRecord(row.props);
    for (const [key, spec] of Object.entries(relation.props)) {
      if (spec.required !== true) continue;
      if (this.valueTerms({ kind: spec.kind, options: spec.options, list: spec.list }, props[key], new Map()).length === 0) {
        return undefined;
      }
    }
    return relation;
  }

  private labelBlock(subject: string, title: string): RdfSubjectBlock {
    return { subject, triples: [{ subject: named(subject), predicate: named(`${RDFS}label`), object: lit(title) }] };
  }

  private common(
    add: (predicate: string, object: RdfTerm) => void,
    reviewStatus: string,
    confidence: number | null,
    ontologyVersion: string,
    evidenceIds: readonly string[],
  ): void {
    add(annotationIri(this.ns, 'reviewStatus'), lit(reviewStatus));
    add(annotationIri(this.ns, 'ontologyVersion'), lit(ontologyVersion));
    if (confidence !== null) {
      const lexical = decimalLexical(confidence);
      if (lexical !== null) add(annotationIri(this.ns, 'confidence'), lit(lexical, `${XSD}decimal`));
    }
    for (const id of evidenceIds) add(`${PROV}wasDerivedFrom`, named(evidenceIri(this.ns, id)));
  }

  /** A `valid` range as prov:startedAtTime/endedAtTime (finite bounds only) + kv:validPrecision. */
  private validRange(
    add: (predicate: string, object: RdfTerm) => void,
    row: { validFrom: Date | null; validTo: Date | null; validPrecision: string | null },
  ): void {
    if (row.validFrom !== null) add(`${PROV}startedAtTime`, dateTime(row.validFrom));
    if (row.validTo !== null) add(`${PROV}endedAtTime`, dateTime(row.validTo));
    if (row.validPrecision !== null && ['day', 'month', 'year', 'unknown'].includes(row.validPrecision)) {
      add(annotationIri(this.ns, 'validPrecision'), lit(row.validPrecision));
    }
  }

  private isSensitive(declared: Sensitivity | null | undefined, typeDefault: Sensitivity): boolean {
    return (declared ?? typeDefault) === 'sensitive';
  }

  /**
   * Built-in (own + mixin) and user attribute values. A key naming no known
   * attribute is not exported (closed shapes, §17.1); a sensitive one is
   * dropped and counted.
   */
  private attributeValues(
    type: Readonly<EntityTypeSpec>,
    rawProps: unknown,
    refTypes: ReadonlyMap<string, string>,
    add: (predicate: string, object: RdfTerm) => void,
  ): void {
    const props = asRecord(rawProps);
    const builtins = new Map(typeAttributes(this.registry, type).map((a) => [a.key, a.spec]));
    for (const key of Object.keys(props).sort()) {
      const value = props[key];
      if (value === null || value === undefined) continue;
      const spec = builtins.get(key);
      if (spec !== undefined) {
        if (this.isSensitive(spec.sensitivity, type.sensitivityDefault)) {
          this.stats.excludedSensitive += 1;
          continue;
        }
        for (const term of this.valueTerms({ kind: spec.kind, options: spec.options, list: spec.list }, value, refTypes)) {
          add(attributeIri(this.ns, type.key, key, spec.alignment), term);
        }
        continue;
      }
      const def = this.userDefs.get(`${type.key}\u0000${key}`);
      if (def === undefined) continue;
      if (this.isSensitive(def.sensitivity, type.sensitivityDefault)) {
        this.stats.excludedSensitive += 1;
        continue;
      }
      if (!this.describedDefIds.has(def.id)) continue;
      for (const term of this.valueTerms({ kind: def.kind, options: def.options }, value, refTypes)) {
        add(userAttributeIri(this.ns, def.id), term);
      }
    }
  }

  /** The literal(s) / IRI(s) one attribute value becomes; empty when invalid. */
  private valueTerms(rules: ValueRules, value: unknown, refTypes: ReadonlyMap<string, string>): RdfTerm[] {
    const multi = isMultiValued(rules.kind, rules.list);
    const values = Array.isArray(value) ? (multi ? value : []) : [value];
    const out: RdfTerm[] = [];
    for (const v of values) {
      const term = this.scalarTerm(rules, v, refTypes);
      if (term !== null) out.push(term);
    }
    return multi ? out : out.slice(0, 1);
  }

  private scalarTerm(rules: ValueRules, v: unknown, refTypes: ReadonlyMap<string, string>): RdfTerm | null {
    const datatype = kindDatatype(rules.kind) ?? XSD_STRING;
    switch (rules.kind) {
      case 'text':
        return typeof v === 'string' && v.length > 0 ? lit(v) : null;
      case 'select':
      case 'multi_select': {
        if (typeof v !== 'string') return null;
        const choices = rules.options?.choices;
        if (choices !== undefined && choices.length > 0 && !choices.some((c) => c.value === v)) return null;
        return lit(v);
      }
      case 'number': {
        const lexical = typeof v === 'number' ? decimalLexical(v) : null;
        return lexical === null ? null : lit(lexical, datatype);
      }
      case 'date':
        return typeof v === 'string' && DATE_ONLY.test(v) ? lit(v, datatype) : null;
      case 'boolean':
        return typeof v === 'boolean' ? lit(String(v), datatype) : null;
      case 'url':
        return typeof v === 'string' && URL_RE.test(v) && !/[\s<>"{}|^`\\]/.test(v) ? lit(v, datatype) : null;
      case 'entity_ref': {
        if (typeof v !== 'string' || !UUID.test(v)) return null;
        const targetType = refTypes.get(v.toLowerCase()) ?? refTypes.get(v);
        const allowed = rules.options?.targetTypes ?? [];
        if (targetType === undefined || (allowed.length > 0 && !allowed.includes(targetType))) return null;
        return named(entityIri(this.ns, v));
      }
    }
  }
}

/** Every `entity_ref` id a row's props name, for resolving which are exported. */
export function entityRefIds(registry: OntologyRegistry, typeKey: string, rawProps: unknown, defs: readonly UserAttributeDef[]): string[] {
  const type = registry.entityType(typeKey);
  if (type === undefined) return [];
  const props = asRecord(rawProps);
  const refKeys = new Set<string>();
  for (const { key, spec } of typeAttributes(registry, type)) if (spec.kind === 'entity_ref') refKeys.add(key);
  for (const def of defs) if (def.entityType === typeKey && def.kind === 'entity_ref') refKeys.add(def.key);
  const out: string[] = [];
  for (const key of refKeys) {
    const value = props[key];
    for (const v of Array.isArray(value) ? value : [value]) if (typeof v === 'string' && UUID.test(v)) out.push(v.toLowerCase());
  }
  return out;
}

// =============================================================================
// GraphExportSource — what `kg.export` reads (issue #386)
// =============================================================================
//
// Every query the export makes, owner-scoped, in one place — so "which rows
// may leave the deployment" has exactly one definition, shared by the page
// readers, the evidence reader, the `graph_empty` check and nothing else:
//
//   entity    accepted | edited, not a merge tombstone (`readable.ts`)
//   item      accepted | edited | superseded (history is part of the graph,
//             §18.2), and its subject — when it has one — is an exported entity.
//             Sensitivity is NOT filtered here: the builder excludes and counts
//             a sensitive fact, so the rule has one enforcement point (#386).
//   relation  accepted | edited, a real `from_id` (never a speaker link), both
//             endpoints exported entities
//   evidence  cites one of the above (proposal-item and import anchors never
//             leave); carries its item subject's sensitivity so the builder
//             can drop a sensitive fact's quote
//
// PAGES OF 1,000, KEYSET ON `id` — so rows arrive in IRI order (`kv:entity/<uuid>`
// sorts as the uuid does; PostgreSQL orders uuids bytewise, which is the order
// of their lowercase hex), which is what lets the handler write a globally
// sorted file without holding it.
//
// ⚠ Never log a row: labels, quotes and statements are the owner's private
// content about third parties.
// =============================================================================

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { UserAttributeDef } from '@app/shared/ontology';

import { NoteAccessService } from '../../notes/access/note-access.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TranscriptAccessService } from '../../transcripts/transcript-access.service';
import { GraphOntologyService } from '../ontology/graph-ontology.service';
import { FINGERPRINT_TABLES, type FingerprintTable, type TableSignature } from './graph-fingerprint';
import type {
  ExportEntityRef,
  ExportEvidenceRow,
  ExportItemRow,
  ExportRelationRow,
} from './rdf-dataset-builder';

/** Rows per page, for every reader. */
export const GRAPH_EXPORT_PAGE_SIZE = 1000;

const ENTITY_STATUSES = Prisma.sql`('accepted', 'edited')`;
const ITEM_STATUSES = Prisma.sql`('accepted', 'edited', 'superseded')`;

/** `e` is an exported entity of `owner`. */
const entityOk = (alias: string, owner: string) =>
  Prisma.sql`${Prisma.raw(alias)}.owner_id = ${owner}::uuid
    AND ${Prisma.raw(alias)}.review_status IN ${ENTITY_STATUSES}
    AND ${Prisma.raw(alias)}.merged_into_id IS NULL`;

/** `i` is an exported item of `owner` (see the header). */
const itemOk = (alias: string, owner: string) =>
  Prisma.sql`${Prisma.raw(alias)}.owner_id = ${owner}::uuid
    AND ${Prisma.raw(alias)}.review_status IN ${ITEM_STATUSES}
    AND (${Prisma.raw(alias)}.subject_id IS NULL OR EXISTS (
      SELECT 1 FROM kg_entities s WHERE s.id = ${Prisma.raw(alias)}.subject_id AND ${entityOk('s', owner)}))`;

/** `r` (joined to `f` and `t`) is an exported relation of `owner`. */
const relationOk = (owner: string) =>
  Prisma.sql`r.owner_id = ${owner}::uuid
    AND r.review_status IN ${ENTITY_STATUSES}
    AND r.from_id IS NOT NULL
    AND ${entityOk('f', owner)}
    AND ${entityOk('t', owner)}`;

interface RawRelation {
  id: string;
  type: string;
  from_id: string;
  from_type: string;
  to_id: string;
  to_type: string;
  props: unknown;
  vfrom: Date | null;
  vto: Date | null;
  valid_precision: string | null;
  review_status: string;
  confidence: number | null;
  ontology_version: string;
}

function toRelation(r: RawRelation): ExportRelationRow {
  return {
    id: r.id,
    type: r.type,
    fromId: r.from_id,
    fromType: r.from_type,
    toId: r.to_id,
    toType: r.to_type,
    props: r.props,
    validFrom: r.vfrom,
    validTo: r.vto,
    validPrecision: r.valid_precision,
    reviewStatus: r.review_status,
    confidence: r.confidence,
    ontologyVersion: r.ontology_version,
  };
}

export interface RawEntityPageRow {
  id: string;
  type: string;
  label: string;
  props: unknown;
  reviewStatus: string;
  occurredAt: Date | null;
  ontologyVersion: string;
}

/** An item row before its column targets are resolved. */
export interface RawItemPageRow extends Omit<ExportItemRow, 'subject' | 'meeting' | 'ownerPerson' | 'counterparty' | 'supersedes' | 'evidenceIds' | 'refTypes'> {
  subjectId: string | null;
  meetingId: string | null;
  ownerPersonId: string | null;
  counterpartyId: string | null;
}

@Injectable()
export class GraphExportSource {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ontology: GraphOntologyService,
    private readonly transcriptAccess: TranscriptAccessService,
    private readonly noteAccess: NoteAccessService,
  ) {}

  /** Every one of the owner's attribute definitions, sensitive included (the builder filters). */
  attributeDefs(ownerId: string): Promise<UserAttributeDef[]> {
    return this.ontology.attributeDefsFor(ownerId);
  }

  /** True when the owner has at least one exported entity or item. */
  async hasExportableRows(ownerId: string): Promise<boolean> {
    const [row] = await this.prisma.$queryRaw<Array<{ any: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM kg_entities e WHERE ${entityOk('e', ownerId)})
          OR EXISTS (SELECT 1 FROM kg_items i WHERE ${itemOk('i', ownerId)}) AS any`;
    return row?.any === true;
  }

  /** The per-table signature `graphFingerprint` hashes. */
  async fingerprintTables(ownerId: string): Promise<Record<FingerprintTable, TableSignature>> {
    const rows = await this.prisma.$queryRaw<Array<{ t: string; n: bigint; at: Date | null }>>`
      SELECT 'kg_entities' AS t, count(*) AS n, max(updated_at) AS at FROM kg_entities WHERE owner_id = ${ownerId}::uuid
      UNION ALL SELECT 'kg_entity_aliases', count(*), max(created_at) FROM kg_entity_aliases WHERE owner_id = ${ownerId}::uuid
      UNION ALL SELECT 'kg_relations', count(*), max(updated_at) FROM kg_relations WHERE owner_id = ${ownerId}::uuid
      UNION ALL SELECT 'kg_items', count(*), max(updated_at) FROM kg_items WHERE owner_id = ${ownerId}::uuid
      UNION ALL SELECT 'kg_evidence', count(*), max(created_at) FROM kg_evidence WHERE owner_id = ${ownerId}::uuid
      UNION ALL SELECT 'kg_attribute_defs', count(*), max(updated_at) FROM kg_attribute_defs WHERE owner_id = ${ownerId}::uuid`;
    const out = {} as Record<FingerprintTable, TableSignature>;
    for (const table of FINGERPRINT_TABLES) out[table] = { count: 0, lastChangedAt: null };
    for (const row of rows) {
      out[row.t as FingerprintTable] = { count: Number(row.n), lastChangedAt: row.at ? row.at.toISOString() : null };
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Entities
  // ---------------------------------------------------------------------------

  async entityPage(ownerId: string, after: string | null): Promise<RawEntityPageRow[]> {
    const cursor = after === null ? Prisma.empty : Prisma.sql`AND e.id > ${after}::uuid`;
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; type: string; label: string; props: unknown; review_status: string; occurred_at: Date | null; ontology_version: string }>
    >`
      SELECT e.id::text AS id, e.type, e.label, e.props, e.review_status::text AS review_status, e.occurred_at, e.ontology_version
      FROM kg_entities e
      WHERE ${entityOk('e', ownerId)} ${cursor}
      ORDER BY e.id
      LIMIT ${GRAPH_EXPORT_PAGE_SIZE}`;
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      label: r.label,
      props: r.props,
      reviewStatus: r.review_status,
      occurredAt: r.occurred_at,
      ontologyVersion: r.ontology_version,
    }));
  }

  /** Aliases per entity id, sorted. */
  async aliasesFor(entityIds: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (entityIds.length === 0) return out;
    const rows = await this.prisma.kgEntityAlias.findMany({
      where: { entityId: { in: [...entityIds] } },
      select: { entityId: true, alias: true },
      orderBy: [{ entityId: 'asc' }, { alias: 'asc' }],
    });
    for (const r of rows) out.set(r.entityId, [...(out.get(r.entityId) ?? []), r.alias]);
    return out;
  }

  /** Evidence ids per subject id, sorted. */
  async evidenceIdsFor(ownerId: string, kind: 'entity' | 'relation' | 'item', subjectIds: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (subjectIds.length === 0) return out;
    const rows = await this.prisma.kgEvidence.findMany({
      where: { ownerId, subjectKind: kind, subjectId: { in: [...subjectIds] } },
      select: { id: true, subjectId: true },
      orderBy: { id: 'asc' },
    });
    for (const r of rows) out.set(r.subjectId, [...(out.get(r.subjectId) ?? []), r.id]);
    return out;
  }

  /** Exported entities among `ids` → their type. */
  async exportedEntityTypes(ownerId: string, ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.prisma.kgEntity.findMany({
      where: { id: { in: unique }, ownerId, reviewStatus: { in: ['accepted', 'edited'] }, mergedIntoId: null },
      select: { id: true, type: true },
    });
    return new Map(rows.map((r) => [r.id, r.type]));
  }

  /** Exported relations leaving any of `fromIds`. */
  async outgoingRelations(ownerId: string, fromIds: readonly string[]): Promise<ExportRelationRow[]> {
    if (fromIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<RawRelation[]>`
      ${this.relationSelect(ownerId)}
      AND r.from_id = ANY(${[...fromIds]}::uuid[])
      ORDER BY r.id`;
    return rows.map(toRelation);
  }

  // ---------------------------------------------------------------------------
  // Relations
  // ---------------------------------------------------------------------------

  async relationPage(ownerId: string, after: string | null): Promise<ExportRelationRow[]> {
    const cursor = after === null ? Prisma.empty : Prisma.sql`AND r.id > ${after}::uuid`;
    const rows = await this.prisma.$queryRaw<RawRelation[]>`
      ${this.relationSelect(ownerId)} ${cursor}
      ORDER BY r.id
      LIMIT ${GRAPH_EXPORT_PAGE_SIZE}`;
    return rows.map(toRelation);
  }

  private relationSelect(ownerId: string): Prisma.Sql {
    return Prisma.sql`
      SELECT r.id::text AS id, r.type, r.from_id::text AS from_id, f.type AS from_type,
             r.to_id::text AS to_id, t.type AS to_type, r.props,
             CASE WHEN r.valid IS NULL OR lower_inf(r.valid) THEN NULL ELSE lower(r.valid) END AS vfrom,
             CASE WHEN r.valid IS NULL OR upper_inf(r.valid) THEN NULL ELSE upper(r.valid) END AS vto,
             r.valid_precision::text AS valid_precision, r.review_status::text AS review_status,
             r.confidence, r.ontology_version
      FROM kg_relations r
      JOIN kg_entities f ON f.id = r.from_id
      JOIN kg_entities t ON t.id = r.to_id
      WHERE ${relationOk(ownerId)}`;
  }

  // ---------------------------------------------------------------------------
  // Items
  // ---------------------------------------------------------------------------

  async itemPage(ownerId: string, after: string | null): Promise<RawItemPageRow[]> {
    const cursor = after === null ? Prisma.empty : Prisma.sql`AND i.id > ${after}::uuid`;
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        kind: string;
        title: string | null;
        statement: string;
        status: string;
        props: unknown;
        occurred_at: Date | null;
        due_at: Date | null;
        vfrom: Date | null;
        vto: Date | null;
        valid_precision: string | null;
        review_status: string;
        confidence: number | null;
        sensitivity: string | null;
        ontology_version: string;
        subject_id: string | null;
        meeting_id: string | null;
        owner_person_id: string | null;
        counterparty_id: string | null;
      }>
    >`
      SELECT i.id::text AS id, i.kind::text AS kind, i.title, i.statement, i.status, i.props,
             i.occurred_at, i.due_at,
             CASE WHEN i.valid IS NULL OR lower_inf(i.valid) THEN NULL ELSE lower(i.valid) END AS vfrom,
             CASE WHEN i.valid IS NULL OR upper_inf(i.valid) THEN NULL ELSE upper(i.valid) END AS vto,
             i.valid_precision::text AS valid_precision, i.review_status::text AS review_status,
             i.confidence, i.sensitivity::text AS sensitivity, i.ontology_version,
             i.subject_id::text AS subject_id, i.meeting_id::text AS meeting_id,
             i.owner_person_id::text AS owner_person_id, i.counterparty_id::text AS counterparty_id
      FROM kg_items i
      WHERE ${itemOk('i', ownerId)} ${cursor}
      ORDER BY i.id
      LIMIT ${GRAPH_EXPORT_PAGE_SIZE}`;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      statement: r.statement,
      status: r.status,
      props: r.props,
      occurredAt: r.occurred_at,
      dueAt: r.due_at,
      validFrom: r.vfrom,
      validTo: r.vto,
      validPrecision: r.valid_precision,
      reviewStatus: r.review_status,
      confidence: r.confidence,
      sensitivity: r.sensitivity,
      ontologyVersion: r.ontology_version,
      subjectId: r.subject_id,
      meetingId: r.meeting_id,
      ownerPersonId: r.owner_person_id,
      counterpartyId: r.counterparty_id,
    }));
  }

  /** Exported items that `newerIds` superseded, grouped by the newer id. */
  async supersededBy(ownerId: string, newerIds: readonly string[]): Promise<Map<string, Array<{ id: string; kind: string }>>> {
    const out = new Map<string, Array<{ id: string; kind: string }>>();
    if (newerIds.length === 0) return out;
    const rows = await this.prisma.$queryRaw<Array<{ id: string; kind: string; newer: string }>>`
      SELECT i.id::text AS id, i.kind::text AS kind, i.superseded_by_id::text AS newer
      FROM kg_items i
      WHERE ${itemOk('i', ownerId)} AND i.superseded_by_id = ANY(${[...newerIds]}::uuid[])
      ORDER BY i.id`;
    for (const r of rows) out.set(r.newer, [...(out.get(r.newer) ?? []), { id: r.id, kind: r.kind }]);
    return out;
  }

  /** Resolve item column ids to exported entity refs. */
  static ref(types: ReadonlyMap<string, string>, id: string | null): ExportEntityRef | null {
    if (id === null) return null;
    const type = types.get(id);
    return type === undefined ? null : { id, type };
  }

  // ---------------------------------------------------------------------------
  // Evidence
  // ---------------------------------------------------------------------------

  async evidencePage(ownerId: string, after: string | null): Promise<ExportEvidenceRow[]> {
    const cursor = after === null ? Prisma.empty : Prisma.sql`AND ev.id > ${after}::uuid`;
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        subject_kind: string;
        subject_sensitivity: string | null;
        quote: string;
        segment_id: string | null;
        start_ms: number | null;
        end_ms: number | null;
        note_id: string | null;
        note_version: number | null;
        char_start: number | null;
        char_end: number | null;
      }>
    >`
      SELECT ev.id::text AS id, ev.subject_kind::text AS subject_kind,
             (SELECT i.sensitivity::text FROM kg_items i WHERE ev.subject_kind = 'item' AND i.id = ev.subject_id) AS subject_sensitivity,
             ev.quote, ev.segment_id::text AS segment_id, ev.start_ms, ev.end_ms,
             ev.note_id::text AS note_id, ev.note_version, ev.char_start, ev.char_end
      FROM kg_evidence ev
      WHERE ev.owner_id = ${ownerId}::uuid ${cursor}
        AND (
          (ev.subject_kind = 'entity' AND EXISTS (SELECT 1 FROM kg_entities e WHERE e.id = ev.subject_id AND ${entityOk('e', ownerId)}))
          OR (ev.subject_kind = 'item' AND EXISTS (SELECT 1 FROM kg_items i WHERE i.id = ev.subject_id AND ${itemOk('i', ownerId)}))
          OR (ev.subject_kind = 'relation' AND EXISTS (
                SELECT 1 FROM kg_relations r JOIN kg_entities f ON f.id = r.from_id JOIN kg_entities t ON t.id = r.to_id
                WHERE r.id = ev.subject_id AND ${relationOk(ownerId)}))
        )
      ORDER BY ev.id
      LIMIT ${GRAPH_EXPORT_PAGE_SIZE}`;
    return rows.map((r) => ({
      id: r.id,
      subjectKind: r.subject_kind,
      subjectSensitivity: r.subject_sensitivity,
      quote: r.quote,
      segmentId: r.segment_id,
      startMs: r.start_ms,
      endMs: r.end_ms,
      noteId: r.note_id,
      noteVersion: r.note_version,
      charStart: r.char_start,
      charEnd: r.char_end,
    }));
  }

  /**
   * Titles for the cited sources the owner can still read: segment id →
   * transcript title, `${noteId}` → note title. A deleted source, or a
   * transcript whose share was revoked, gets no label (§18.2: labels only while
   * readable).
   */
  async sourceTitles(
    ownerId: string,
    segmentIds: readonly string[],
    noteIds: readonly string[],
  ): Promise<{ segments: Map<string, string>; notes: Map<string, string> }> {
    const segments = new Map<string, string>();
    const notes = new Map<string, string>();
    if (segmentIds.length > 0) {
      const segs = await this.prisma.transcriptSegment.findMany({
        where: { id: { in: [...segmentIds] } },
        select: { id: true, transcriptId: true },
      });
      const transcripts = await this.prisma.transcript.findMany({
        where: { id: { in: [...new Set(segs.map((s) => s.transcriptId))] }, deletedAt: null },
      });
      const titles = new Map<string, string>();
      for (const t of transcripts) {
        if ((await this.transcriptAccess.roleFor(ownerId, t)) !== null) titles.set(t.id, t.title);
      }
      for (const s of segs) {
        const title = titles.get(s.transcriptId);
        if (title !== undefined) segments.set(s.id, title);
      }
    }
    if (noteIds.length > 0) {
      const rows = await this.prisma.note.findMany({ where: { id: { in: [...noteIds] }, deletedAt: null } });
      for (const n of rows) if (this.noteAccess.roleFor(ownerId, n) !== null) notes.set(n.id, n.title);
    }
    return { segments, notes };
  }
}

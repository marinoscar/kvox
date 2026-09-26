// =============================================================================
// Bounded, owner-scoped reads for the entity brief and its digest (#372)
// =============================================================================
//
// Every statement carries `owner_id = $owner` and the shared readable-status
// fragments from `read/read-sql.ts` (#370), so the brief, the digest job and
// the rest of the read layer agree on what is "readable": never an
// `unreviewed`/`rejected` row, never a merge tombstone, never a `sensitive`
// person fact. Every query is LIMITed.
//
// ⚠ Never log a label, a statement or a quote from here — ids and counts only.
// =============================================================================

import { Prisma } from '@prisma/client';

import { relationValidAtSql } from '../read/as-of';
import {
  asOfRelationSql,
  notSensitiveSql,
  readableEntitySql,
  readableItemSql,
  readableRelationSql,
  textArray,
  uuidArray,
} from '../read/read-sql';
import { TIMELINE_ITEM_STATUSES } from '../read/readable';
import type { ValidRange } from '../temporal';
import type { BriefEntityRef } from './dto/entity-brief.dto';
import type { BriefItemKind, BriefItemRow, BriefRelationRow } from './brief-sections';
import type { RelatedKind } from './brief-related';

/** Anything that can run `$queryRaw` — the Prisma client or a transaction. */
export type BriefDb = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** Items read for one brief (newest first). */
export const BRIEF_ITEM_ROW_LIMIT = 500;
/** Relations read for "People changes". */
export const BRIEF_RELATION_ROW_LIMIT = 200;
/** 1-hop Persons considered for "People changes". */
export const BRIEF_ONE_HOP_PERSON_LIMIT = 200;
/** Persons considered "theirs" for an Organization. */
export const BRIEF_WORKER_LIMIT = 500;
/** Distinct documents the graph arm considers before ranking. */
export const BRIEF_GRAPH_DOC_CANDIDATES = 200;

/** The relation type that makes a Person's commitments an Organization's "theirs" (spec §9.1). */
export const WORKS_FOR = 'WORKS_FOR';

const owner = (id: string) => Prisma.sql`${id}::uuid`;

/** Items naming `entityId` in any column. */
function touchesSql(alias: string, entityId: string): Prisma.Sql {
  const t = Prisma.raw(alias);
  const me = Prisma.sql`${entityId}::uuid`;
  return Prisma.sql`(${t}.subject_id = ${me} OR ${t}.owner_person_id = ${me} OR ${t}.counterparty_id = ${me} OR ${t}.meeting_id = ${me})`;
}

/**
 * A person fact may count toward "is there something to summarize" only when
 * the digest may send it to a model: `business` always, `personal` with the
 * §14 opt-in, `sensitive` never (§15).
 */
function promptableItemSql(alias: string, includePersonalFacts: boolean): Prisma.Sql {
  const t = Prisma.raw(alias);
  return includePersonalFacts
    ? notSensitiveSql(alias)
    : Prisma.sql`(${t}.kind <> 'person_fact' OR ${t}.sensitivity = 'business')`;
}

function toRange(vnull: boolean, vfrom: Date | null, vto: Date | null): ValidRange | null {
  return vnull ? null : { from: vfrom, to: vto };
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export type EvidenceSubjects = Partial<Record<'item' | 'relation' | 'entity', readonly string[]>>;

/** Up to `perSubject` evidence ids (oldest first) per `kind:id` — one query. */
export async function evidenceIdsFor(
  db: BriefDb,
  ownerId: string,
  subjects: EvidenceSubjects,
  perSubject: number,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const clauses: Prisma.Sql[] = [];
  for (const kind of ['item', 'relation', 'entity'] as const) {
    const ids = subjects[kind];
    if (ids && ids.length > 0) {
      clauses.push(Prisma.sql`(ev.subject_kind = ${Prisma.raw(`'${kind}'`)} AND ev.subject_id = ANY(${uuidArray(ids)}))`);
    }
  }
  if (clauses.length === 0) return out;
  const rows = await db.$queryRaw<{ kind: string; subject_id: string; id: string }[]>`
    SELECT x.kind, x.subject_id, x.id FROM (
      SELECT ev.subject_kind::text AS kind, ev.subject_id::text AS subject_id, ev.id::text AS id,
             row_number() OVER (PARTITION BY ev.subject_kind, ev.subject_id ORDER BY ev.created_at, ev.id) AS rn
      FROM kg_evidence ev
      WHERE ev.owner_id = ${owner(ownerId)} AND (${Prisma.join(clauses, ' OR ')})
    ) x WHERE x.rn <= ${perSubject}
    ORDER BY x.kind, x.subject_id, x.rn`;
  for (const r of rows) {
    const key = `${r.kind}:${r.subject_id}`;
    const list = out.get(key) ?? [];
    list.push(r.id);
    out.set(key, list);
  }
  return out;
}

/** The subset of `ids` that are evidence rows this owner still has. */
export async function ownedEvidenceIds(db: BriefDb, ownerId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT ev.id::text AS id FROM kg_evidence ev
    WHERE ev.owner_id = ${owner(ownerId)} AND ev.id = ANY(${uuidArray([...new Set(ids)])})`;
  return new Set(rows.map((r) => r.id));
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** Readable entity refs by id. */
export async function entityRefs(db: BriefDb, ownerId: string, ids: readonly string[]): Promise<Map<string, BriefEntityRef>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.$queryRaw<BriefEntityRef[]>`
    SELECT e.id::text AS id, e.label, e.type FROM kg_entities e
    WHERE e.owner_id = ${owner(ownerId)} AND e.id = ANY(${uuidArray(unique)}) AND ${readableEntitySql('e')}`;
  return new Map(rows.map((r) => [r.id, r]));
}

/** Persons with a `WORKS_FOR` to `entityId` valid at `asOf`. */
export async function workerIds(db: BriefDb, ownerId: string, entityId: string, asOf: Date): Promise<Set<string>> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT r.from_id::text AS id
    FROM kg_relations r
    JOIN kg_entities p ON p.id = r.from_id AND p.owner_id = ${owner(ownerId)} AND ${readableEntitySql('p')}
    WHERE r.owner_id = ${owner(ownerId)} AND r.to_id = ${entityId}::uuid AND r.type = ${WORKS_FOR}
      AND ${asOfRelationSql('r')} AND ${relationValidAtSql('r', asOf)}
    LIMIT ${BRIEF_WORKER_LIMIT}`;
  return new Set(rows.map((r) => r.id));
}

/** Persons one hop from `entityId` over any relation valid at `asOf`. */
export async function oneHopPersonIds(db: BriefDb, ownerId: string, entityId: string, asOf: Date): Promise<string[]> {
  const me = Prisma.sql`${entityId}::uuid`;
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT o.id::text AS id
    FROM kg_relations r
    JOIN kg_entities o ON o.id = CASE WHEN r.from_id = ${me} THEN r.to_id ELSE r.from_id END
      AND o.owner_id = ${owner(ownerId)} AND o.type = 'Person' AND ${readableEntitySql('o')}
    WHERE r.owner_id = ${owner(ownerId)} AND (r.from_id = ${me} OR r.to_id = ${me}) AND r.from_id IS NOT NULL
      AND ${asOfRelationSql('r')} AND ${relationValidAtSql('r', asOf)}
    LIMIT ${BRIEF_ONE_HOP_PERSON_LIMIT}`;
  return rows.map((r) => r.id).filter((id) => id !== entityId);
}

// ---------------------------------------------------------------------------
// Items and relations for the sections
// ---------------------------------------------------------------------------

interface ItemSqlRow {
  id: string;
  kind: BriefItemKind;
  title: string | null;
  statement: string;
  status: string | null;
  occurred_at: Date | null;
  due_at: Date | null;
  precision: string | null;
  subject_id: string | null;
  owner_person_id: string | null;
  counterparty_id: string | null;
  meeting_id: string | null;
  review_status: string;
  superseded_by_id: string | null;
  superseded_by_occurred_at: Date | null;
  sensitivity: string | null;
  vfrom: Date | null;
  vto: Date | null;
  vnull: boolean;
}

/**
 * Items about the entity (any column) — plus, for an Organization, the
 * commitments its current workers own — stated by `asOf`. Accepted, edited
 * and superseded (flagged later); never sensitive. Newest first.
 */
export async function briefItems(
  db: BriefDb,
  ownerId: string,
  entityId: string,
  workers: ReadonlySet<string>,
  asOf: Date,
): Promise<BriefItemRow[]> {
  const workerClause =
    workers.size > 0
      ? Prisma.sql`OR (i.kind = 'commitment' AND i.owner_person_id = ANY(${uuidArray([...workers])}))`
      : Prisma.empty;
  const rows = await db.$queryRaw<ItemSqlRow[]>`
    SELECT i.id::text AS id, i.kind::text AS kind, i.title, i.statement, i.status,
           i.occurred_at, i.due_at, i.valid_precision::text AS precision,
           i.subject_id::text AS subject_id, i.owner_person_id::text AS owner_person_id,
           i.counterparty_id::text AS counterparty_id, i.meeting_id::text AS meeting_id,
           i.review_status::text AS review_status, i.superseded_by_id::text AS superseded_by_id,
           s.occurred_at AS superseded_by_occurred_at, i.sensitivity::text AS sensitivity,
           lower(i.valid) AS vfrom, upper(i.valid) AS vto, (i.valid IS NULL) AS vnull
    FROM kg_items i
    LEFT JOIN kg_items s ON s.id = i.superseded_by_id AND s.owner_id = i.owner_id
    WHERE i.owner_id = ${owner(ownerId)}
      AND (${touchesSql('i', entityId)} ${workerClause})
      AND ${readableItemSql('i', TIMELINE_ITEM_STATUSES)} AND ${notSensitiveSql('i')}
      AND (i.occurred_at IS NULL OR i.occurred_at <= ${asOf}::timestamptz)
    ORDER BY i.occurred_at DESC NULLS LAST, i.id DESC
    LIMIT ${BRIEF_ITEM_ROW_LIMIT}`;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    statement: r.statement,
    status: r.status,
    occurredAt: r.occurred_at,
    dueAt: r.due_at,
    precision: r.precision,
    subjectId: r.subject_id,
    ownerPersonId: r.owner_person_id,
    counterpartyId: r.counterparty_id,
    meetingId: r.meeting_id,
    reviewStatus: r.review_status,
    supersededById: r.superseded_by_id,
    supersededByOccurredAt: r.superseded_by_occurred_at,
    sensitivity: r.sensitivity,
    valid: toRange(r.vnull, r.vfrom, r.vto),
    evidenceIds: [],
  }));
}

interface RelationSqlRow {
  id: string;
  type: string;
  from_id: string;
  to_id: string;
  props: unknown;
  vfrom: Date | null;
  vto: Date | null;
  precision: string | null;
}

const toRelationRow = (r: RelationSqlRow): BriefRelationRow => ({
  id: r.id,
  type: r.type,
  fromId: r.from_id,
  toId: r.to_id,
  props: r.props && typeof r.props === 'object' ? (r.props as Record<string, unknown>) : {},
  validFrom: r.vfrom,
  validTo: r.vto,
  precision: r.precision,
  evidenceIds: [],
});

/**
 * Exclusive-type relations touching any of `entityIds` whose start or finite
 * end falls in `(since, asOf]`. Superseded edges included — a closed edge is
 * exactly what "People changes" reports.
 */
export async function peopleChangeRelations(
  db: BriefDb,
  ownerId: string,
  entityIds: readonly string[],
  exclusiveTypes: readonly string[],
  since: Date | null,
  asOf: Date,
): Promise<BriefRelationRow[]> {
  if (exclusiveTypes.length === 0 || entityIds.length === 0) return [];
  const after = (expr: Prisma.Sql) => (since ? Prisma.sql`AND ${expr} > ${since}::timestamptz` : Prisma.empty);
  const rows = await db.$queryRaw<RelationSqlRow[]>`
    SELECT r.id::text AS id, r.type, r.from_id::text AS from_id, r.to_id::text AS to_id, r.props,
           CASE WHEN lower_inf(r.valid) THEN NULL ELSE lower(r.valid) END AS vfrom,
           CASE WHEN upper_inf(r.valid) THEN NULL ELSE upper(r.valid) END AS vto,
           r.valid_precision::text AS precision
    FROM kg_relations r
    WHERE r.owner_id = ${owner(ownerId)} AND r.type = ANY(${textArray(exclusiveTypes)}) AND r.from_id IS NOT NULL
      AND (r.from_id = ANY(${uuidArray(entityIds)}) OR r.to_id = ANY(${uuidArray(entityIds)}))
      AND ${asOfRelationSql('r')} AND r.valid IS NOT NULL
      AND (
        (NOT lower_inf(r.valid) AND lower(r.valid) <= ${asOf}::timestamptz ${after(Prisma.sql`lower(r.valid)`)})
        OR (NOT upper_inf(r.valid) AND upper(r.valid) <= ${asOf}::timestamptz ${after(Prisma.sql`upper(r.valid)`)})
      )
    ORDER BY greatest(lower(r.valid), CASE WHEN upper_inf(r.valid) THEN NULL ELSE upper(r.valid) END) DESC NULLS LAST, r.id
    LIMIT ${BRIEF_RELATION_ROW_LIMIT}`;
  return rows.map(toRelationRow);
}

// ---------------------------------------------------------------------------
// Staleness — shared by the brief and the digest job so they cannot disagree
// ---------------------------------------------------------------------------

export interface NewestChange {
  /** Newest dated change (item `occurred_at`, exclusive edge start/end) at or before `now`. */
  at: Date | null;
  /** Newest write to any of those rows (`updated_at`) — catches a back-dated commit. */
  writtenAt: Date | null;
}

/**
 * What the digest would have to account for. Only rows the digest may put in
 * a prompt count (§15): a personal fact that can never be summarized must not
 * keep a digest permanently "stale".
 */
export async function newestChange(
  db: BriefDb,
  ownerId: string,
  entityId: string,
  exclusiveTypes: readonly string[],
  now: Date,
  includePersonalFacts = false,
): Promise<NewestChange> {
  const me = Prisma.sql`${entityId}::uuid`;
  const types = exclusiveTypes.length > 0 ? exclusiveTypes : ['__none__'];
  const [row] = await db.$queryRaw<{ at: Date | null; written_at: Date | null }[]>`
    WITH it AS (
      SELECT max(i.occurred_at) FILTER (WHERE i.occurred_at <= ${now}::timestamptz) AS at, max(i.updated_at) AS written_at
      FROM kg_items i
      WHERE i.owner_id = ${owner(ownerId)} AND ${touchesSql('i', entityId)}
        AND ${readableItemSql('i')} AND ${notSensitiveSql('i')} AND ${promptableItemSql('i', includePersonalFacts)}
    ), rel AS (
      SELECT max(greatest(
               CASE WHEN NOT lower_inf(r.valid) AND lower(r.valid) <= ${now}::timestamptz THEN lower(r.valid) END,
               CASE WHEN NOT upper_inf(r.valid) AND upper(r.valid) <= ${now}::timestamptz THEN upper(r.valid) END)) AS at,
             max(r.updated_at) AS written_at
      FROM kg_relations r
      WHERE r.owner_id = ${owner(ownerId)} AND r.type = ANY(${textArray(types)}) AND r.from_id IS NOT NULL
        AND (r.from_id = ${me} OR r.to_id = ${me}) AND ${asOfRelationSql('r')}
    )
    SELECT greatest(it.at, rel.at) AS at, greatest(it.written_at, rel.written_at) AS written_at FROM it, rel`;
  return { at: row?.at ?? null, writtenAt: row?.written_at ?? null };
}

/** Whether a digest (or its absence) is stale against `change`. */
export function isDigestStale(
  digest: { coversUntil: Date; generatedAt: Date } | null,
  change: NewestChange,
): boolean {
  if (change.at === null && change.writtenAt === null) return false;
  if (digest === null) return true;
  if (change.at !== null && digest.coversUntil.getTime() < change.at.getTime()) return true;
  return change.writtenAt !== null && change.writtenAt.getTime() > digest.generatedAt.getTime();
}

// ---------------------------------------------------------------------------
// Digest input
// ---------------------------------------------------------------------------

export interface DigestItemRow {
  id: string;
  kind: BriefItemKind;
  title: string | null;
  statement: string;
  status: string | null;
  occurredAt: Date | null;
  dueAt: Date | null;
  sensitivity: string | null;
}

/**
 * Items the digest has not yet accounted for: stated after `coversUntil`, or
 * written after the last digest (a back-dated commit). Readable, never
 * sensitive; personal facts only with the opt-in. Newest first.
 */
export async function digestItems(
  db: BriefDb,
  ownerId: string,
  entityId: string,
  previous: { coversUntil: Date; generatedAt: Date } | null,
  limit: number,
  includePersonalFacts: boolean,
): Promise<DigestItemRow[]> {
  const fresh = previous
    ? Prisma.sql`AND (i.occurred_at > ${previous.coversUntil}::timestamptz OR i.updated_at > ${previous.generatedAt}::timestamptz)`
    : Prisma.empty;
  const rows = await db.$queryRaw<
    { id: string; kind: BriefItemKind; title: string | null; statement: string; status: string | null; occurred_at: Date | null; due_at: Date | null; sensitivity: string | null }[]
  >`
    SELECT i.id::text AS id, i.kind::text AS kind, i.title, i.statement, i.status, i.occurred_at, i.due_at,
           i.sensitivity::text AS sensitivity
    FROM kg_items i
    WHERE i.owner_id = ${owner(ownerId)} AND ${touchesSql('i', entityId)}
      AND ${readableItemSql('i')} AND ${notSensitiveSql('i')} AND ${promptableItemSql('i', includePersonalFacts)}
      ${fresh}
    ORDER BY i.occurred_at DESC NULLS LAST, i.id DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    statement: r.statement,
    status: r.status,
    occurredAt: r.occurred_at,
    dueAt: r.due_at,
    sensitivity: r.sensitivity,
  }));
}

export interface DigestRelationRow extends BriefRelationRow {
  fromLabel: string;
  toLabel: string;
  updatedAt: Date;
}

/**
 * Exclusive edges touching the entity that are open now, or that closed after
 * the previous digest's `coversUntil` — the "people changes" the summary must
 * reflect. Both ends readable.
 */
export async function digestRelations(
  db: BriefDb,
  ownerId: string,
  entityId: string,
  exclusiveTypes: readonly string[],
  coversUntil: Date | null,
  now: Date,
  limit: number,
): Promise<DigestRelationRow[]> {
  if (exclusiveTypes.length === 0) return [];
  const me = Prisma.sql`${entityId}::uuid`;
  const closedRecently = coversUntil
    ? Prisma.sql`(NOT upper_inf(r.valid) AND upper(r.valid) > ${coversUntil}::timestamptz AND upper(r.valid) <= ${now}::timestamptz)`
    : Prisma.sql`(NOT upper_inf(r.valid) AND upper(r.valid) <= ${now}::timestamptz)`;
  const rows = await db.$queryRaw<(RelationSqlRow & { from_label: string; to_label: string; updated_at: Date })[]>`
    SELECT r.id::text AS id, r.type, r.from_id::text AS from_id, r.to_id::text AS to_id, r.props,
           CASE WHEN r.valid IS NULL OR lower_inf(r.valid) THEN NULL ELSE lower(r.valid) END AS vfrom,
           CASE WHEN r.valid IS NULL OR upper_inf(r.valid) THEN NULL ELSE upper(r.valid) END AS vto,
           r.valid_precision::text AS precision, f.label AS from_label, t.label AS to_label, r.updated_at
    FROM kg_relations r
    JOIN kg_entities f ON f.id = r.from_id AND f.owner_id = ${owner(ownerId)} AND ${readableEntitySql('f')}
    JOIN kg_entities t ON t.id = r.to_id AND t.owner_id = ${owner(ownerId)} AND ${readableEntitySql('t')}
    WHERE r.owner_id = ${owner(ownerId)} AND r.type = ANY(${textArray(exclusiveTypes)})
      AND (r.from_id = ${me} OR r.to_id = ${me})
      AND (
        (${readableRelationSql('r')} AND ${relationValidAtSql('r', now)})
        OR (${asOfRelationSql('r')} AND r.valid IS NOT NULL AND ${closedRecently})
      )
    ORDER BY lower(r.valid) DESC NULLS LAST, r.id
    LIMIT ${limit}`;
  return rows.map((r) => ({ ...toRelationRow(r), fromLabel: r.from_label, toLabel: r.to_label, updatedAt: r.updated_at }));
}

// ---------------------------------------------------------------------------
// Related sources: the graph arm and document visibility
// ---------------------------------------------------------------------------

export interface GraphDocCandidate {
  kind: RelatedKind;
  id: string;
  confidence: number;
}

/**
 * Documents cited by the entity's readable graph rows (its own evidence, its
 * relations and its items), with the mean confidence of the cited rows.
 */
export async function graphDocCandidates(db: BriefDb, ownerId: string, entityId: string): Promise<GraphDocCandidate[]> {
  const me = Prisma.sql`${entityId}::uuid`;
  const rows = await db.$queryRaw<{ kind: RelatedKind; id: string; confidence: number }[]>`
    WITH sub AS (
      SELECT 'entity'::text AS kind, ${me} AS id, 1.0::float8 AS conf
      UNION ALL
      SELECT 'relation', r.id, coalesce(r.confidence, 1.0)::float8 FROM kg_relations r
      WHERE r.owner_id = ${owner(ownerId)} AND (r.from_id = ${me} OR r.to_id = ${me}) AND ${readableRelationSql('r')}
      UNION ALL
      SELECT 'item', i.id, coalesce(i.confidence, 1.0)::float8 FROM kg_items i
      WHERE i.owner_id = ${owner(ownerId)} AND ${touchesSql('i', entityId)} AND ${readableItemSql('i')} AND ${notSensitiveSql('i')}
    )
    SELECT x.kind, x.id, avg(x.conf)::float8 AS confidence FROM (
      SELECT CASE WHEN ev.transcript_id IS NOT NULL THEN 'transcript' ELSE 'note' END AS kind,
             coalesce(ev.transcript_id, ev.note_id)::text AS id, sub.conf
      FROM kg_evidence ev
      JOIN sub ON sub.kind = ev.subject_kind::text AND sub.id = ev.subject_id
      WHERE ev.owner_id = ${owner(ownerId)} AND (ev.transcript_id IS NOT NULL OR ev.note_id IS NOT NULL)
    ) x
    GROUP BY x.kind, x.id
    LIMIT ${BRIEF_GRAPH_DOC_CANDIDATES}`;
  return rows.map((r) => ({ kind: r.kind, id: r.id, confidence: Number(r.confidence) }));
}

export interface VisibleDoc {
  kind: RelatedKind;
  id: string;
  title: string;
  occurredAt: Date | null;
}

/**
 * The documents among `transcriptIds`/`noteIds` the caller may still VIEW —
 * a live transcript they own or hold a share on, a live note they own (the
 * same predicates `GraphReadService.mentions` uses) — with the meeting date:
 * a transcript's `recorded_at`, a note's `created_at`.
 */
export async function visibleDocs(
  db: BriefDb,
  userId: string,
  transcriptIds: readonly string[],
  noteIds: readonly string[],
): Promise<VisibleDoc[]> {
  const branches: Prisma.Sql[] = [];
  if (transcriptIds.length > 0) {
    branches.push(Prisma.sql`
      SELECT 'transcript' AS kind, t.id::text AS id, t.title, t.recorded_at AS at FROM transcripts t
      WHERE t.id = ANY(${uuidArray(transcriptIds)}) AND t.deleted_at IS NULL
        AND (t.owner_id = ${owner(userId)} OR EXISTS (
          SELECT 1 FROM transcript_shares s WHERE s.transcript_id = t.id AND s.user_id = ${owner(userId)}))`);
  }
  if (noteIds.length > 0) {
    branches.push(Prisma.sql`
      SELECT 'note' AS kind, n.id::text AS id, n.title, n.created_at AS at FROM notes n
      WHERE n.id = ANY(${uuidArray(noteIds)}) AND n.deleted_at IS NULL AND n.owner_id = ${owner(userId)}`);
  }
  if (branches.length === 0) return [];
  const rows = await db.$queryRaw<{ kind: RelatedKind; id: string; title: string; at: Date | null }[]>`
    ${Prisma.join(branches, ' UNION ALL ')}`;
  return rows.map((r) => ({ kind: r.kind, id: r.id, title: r.title, occurredAt: r.at }));
}

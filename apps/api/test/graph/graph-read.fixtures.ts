// =============================================================================
// Real-Postgres fixtures for the graph read layer's DB specs (#370)
// =============================================================================
//
// Rows are written with Prisma/raw SQL directly rather than through
// `GraphWriteService`, because these specs need states the write path refuses
// to create on purpose (a merge tombstone, an `unreviewed` row, a relation
// pointing at an arbitrary type). Every accepted/edited row still gets its
// evidence in the SAME transaction, so the deferred no-orphans trigger
// (`kg_assert_has_evidence`) is satisfied at COMMIT exactly as in production.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { buildDatabaseUrl } from '../../src/common/database-url';

type ReviewStatus = 'accepted' | 'edited' | 'unreviewed' | 'rejected' | 'merged' | 'superseded';
const CURATED: ReadonlySet<string> = new Set(['accepted', 'edited']);

export function connectTestPrisma(): PrismaClient {
  const { DATABASE_URL: _ignored, ...env } = process.env;
  return new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(env)) });
}

export async function createUser(prisma: PrismaClient, prefix: string, suffix: string) {
  return prisma.user.create({
    data: { email: `${prefix}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test` },
  });
}

/**
 * Delete every row these fixtures create for users whose email starts with
 * `prefix`.
 *
 * Runs inside one transaction with `SET LOCAL session_replication_role =
 * replica` (the same technique `docs/specs/search.md` §2 cites for why the
 * search-vector columns are `GENERATED` rather than trigger-maintained: a
 * `replica`-role session skips `ORIGIN`-mode triggers, which is what every
 * trigger here is by default). That disables `kg_assert_has_evidence`
 * (`kg_evidence_invariant` migration) for the duration of the cleanup: each
 * of the perf fixture's ~50k evidence-row deletes stops firing a per-row
 * deferred-trigger `SELECT … FROM kg_entities/kg_relations/kg_items WHERE id
 * = $1` lookup, which is what made this teardown take ~95s. The invariant
 * itself is irrelevant to a teardown that is about to delete every row on
 * both sides of it anyway — this is cleanup, not a write path any production
 * code exercises, so skipping the check is safe. `SET LOCAL` is
 * transaction-scoped and never leaks to the connection pool's next borrower.
 */
export async function cleanupGraphFixtures(prisma: PrismaClient, prefix: string): Promise<void> {
  const owner = { owner: { email: { startsWith: prefix } } };
  const userFilter = { email: { startsWith: prefix } };
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.kgEntityView.deleteMany({ where: { user: userFilter } });
      await tx.kgMention.deleteMany({ where: owner });
      await tx.kgEvidence.deleteMany({ where: owner });
      await tx.kgRelation.deleteMany({ where: owner });
      await tx.kgItem.deleteMany({ where: owner });
      await tx.kgEntityAlias.deleteMany({ where: owner });
      await tx.kgEntity.deleteMany({ where: owner });
      await tx.transcriptShare.deleteMany({ where: { transcript: owner } });
      await tx.transcriptSegment.deleteMany({ where: { transcript: owner } });
      await tx.transcriptSpeaker.deleteMany({ where: { transcript: owner } });
      await tx.transcript.deleteMany({ where: owner });
      await tx.storageObject.deleteMany({ where: { uploadedBy: userFilter } });
      await tx.noteVersion.deleteMany({ where: { note: owner } });
      await tx.note.deleteMany({ where: owner });
      await tx.user.deleteMany({ where: userFilter });
    },
    { timeout: 120_000 },
  );
}

export interface EntityOpts {
  reviewStatus?: ReviewStatus;
  occurredAt?: Date | null;
  props?: Record<string, unknown>;
  mergedIntoId?: string | null;
  aliases?: string[];
  updatedAt?: Date;
}

export interface RelationOpts {
  /** A `tstzrange` literal, e.g. `'[2020-01-01,2026-03-01)'`; omitted = NULL. */
  valid?: string | null;
  precision?: 'day' | 'month' | 'year' | 'unknown' | null;
  reviewStatus?: ReviewStatus;
  confidence?: number | null;
  fromSpeakerId?: string;
}

export interface ItemOpts {
  subjectId?: string | null;
  ownerPersonId?: string | null;
  counterpartyId?: string | null;
  meetingId?: string | null;
  title?: string | null;
  statement?: string;
  status?: string;
  occurredAt?: Date | null;
  dueAt?: Date | null;
  sensitivity?: 'business' | 'personal' | 'sensitive' | null;
  reviewStatus?: ReviewStatus;
  valid?: string | null;
  precision?: 'day' | 'month' | 'year' | 'unknown' | null;
  supersededById?: string | null;
}

/** A small builder bound to one owner. Each call is one transaction. */
export class GraphFixture {
  constructor(
    private readonly prisma: PrismaClient,
    readonly ownerId: string,
  ) {}

  async evidence(subjectKind: 'entity' | 'relation' | 'item', subjectId: string, extra: Partial<Prisma.KgEvidenceUncheckedCreateInput> = {}) {
    return this.prisma.kgEvidence.create({
      data: { ownerId: this.ownerId, subjectKind, subjectId, quote: 'quoted text', ...extra },
    });
  }

  async entity(type: string, label: string, opts: EntityOpts = {}): Promise<string> {
    const id = randomUUID();
    const status = opts.reviewStatus ?? 'accepted';
    await this.prisma.$transaction(async (tx) => {
      await tx.kgEntity.create({
        data: {
          id,
          ownerId: this.ownerId,
          type,
          label,
          props: (opts.props ?? {}) as Prisma.InputJsonObject,
          reviewStatus: status,
          occurredAt: opts.occurredAt ?? null,
          mergedIntoId: opts.mergedIntoId ?? null,
          ontologyVersion: '1.0.0',
        },
      });
      for (const alias of [label, ...(opts.aliases ?? [])]) {
        await tx.kgEntityAlias.create({
          data: { entityId: id, ownerId: this.ownerId, alias, normalized: alias.toLowerCase(), source: 'extraction' },
        });
      }
      if (CURATED.has(status) || status === 'merged') {
        await tx.kgEvidence.create({ data: { ownerId: this.ownerId, subjectKind: 'entity', subjectId: id, quote: label } });
      }
      if (opts.updatedAt) {
        await tx.$executeRaw`UPDATE kg_entities SET updated_at = ${opts.updatedAt}::timestamptz WHERE id = ${id}::uuid`;
      }
    });
    return id;
  }

  async relation(type: string, fromId: string | null, toId: string, opts: RelationOpts = {}): Promise<string> {
    const id = randomUUID();
    const status = opts.reviewStatus ?? 'accepted';
    await this.prisma.$transaction(async (tx) => {
      await tx.kgRelation.create({
        data: {
          id,
          ownerId: this.ownerId,
          type,
          fromId,
          fromSpeakerId: opts.fromSpeakerId ?? null,
          toId,
          reviewStatus: status,
          confidence: opts.confidence ?? null,
          ontologyVersion: '1.0.0',
        },
      });
      if (opts.valid !== undefined || opts.precision !== undefined) {
        await tx.$executeRaw`UPDATE kg_relations SET valid = ${opts.valid ?? null}::tstzrange,
          valid_precision = ${opts.precision ?? null}::kg_valid_precision WHERE id = ${id}::uuid`;
      }
      if (CURATED.has(status) || status === 'superseded') {
        await tx.kgEvidence.create({ data: { ownerId: this.ownerId, subjectKind: 'relation', subjectId: id, quote: type } });
      }
    });
    return id;
  }

  async item(kind: 'commitment' | 'decision' | 'claim' | 'person_fact', opts: ItemOpts = {}): Promise<string> {
    const id = randomUUID();
    const status = opts.reviewStatus ?? 'accepted';
    await this.prisma.$transaction(async (tx) => {
      await tx.kgItem.create({
        data: {
          id,
          ownerId: this.ownerId,
          kind,
          subjectId: opts.subjectId ?? null,
          ownerPersonId: opts.ownerPersonId ?? null,
          counterpartyId: opts.counterpartyId ?? null,
          meetingId: opts.meetingId ?? null,
          title: opts.title ?? null,
          statement: opts.statement ?? `${kind} ${id}`,
          status: opts.status ?? (kind === 'commitment' ? 'open' : 'active'),
          occurredAt: opts.occurredAt ?? null,
          dueAt: opts.dueAt ?? null,
          sensitivity: kind === 'person_fact' ? (opts.sensitivity ?? 'personal') : null,
          statementHash: randomUUID(),
          reviewStatus: status,
          supersededById: opts.supersededById ?? null,
          ontologyVersion: '1.0.0',
        },
      });
      if (opts.valid !== undefined || opts.precision !== undefined) {
        await tx.$executeRaw`UPDATE kg_items SET valid = ${opts.valid ?? null}::tstzrange,
          valid_precision = ${opts.precision ?? null}::kg_valid_precision WHERE id = ${id}::uuid`;
      }
      if (CURATED.has(status) || status === 'superseded') {
        await tx.kgEvidence.create({ data: { ownerId: this.ownerId, subjectKind: 'item', subjectId: id, quote: kind } });
      }
    });
    return id;
  }

  async transcript(opts: { recordedAt?: Date; title?: string } = {}) {
    const source = await this.prisma.storageObject.create({
      data: {
        name: 'r.m4a',
        size: BigInt(1),
        mimeType: 'audio/mp4',
        storageKey: `graph-read-test/${randomUUID()}`,
        managedBy: 'transcripts',
        uploadedById: this.ownerId,
      },
    });
    const transcript = await this.prisma.transcript.create({
      data: {
        ownerId: this.ownerId,
        title: opts.title ?? 'Weekly sync',
        sourceObjectId: source.id,
        provider: 'assemblyai',
        ...(opts.recordedAt ? { recordedAt: opts.recordedAt } : {}),
      },
    });
    const speakerA = await this.prisma.transcriptSpeaker.create({
      data: { transcriptId: transcript.id, label: 'A', displayName: 'Speaker A', colorIndex: 0 },
    });
    const speakerB = await this.prisma.transcriptSpeaker.create({
      data: { transcriptId: transcript.id, label: 'B', displayName: 'Speaker B', colorIndex: 1 },
    });
    const segment = await this.prisma.transcriptSegment.create({
      data: {
        transcriptId: transcript.id,
        speakerId: speakerA.id,
        startMs: 1500,
        endMs: 4000,
        ordinal: 1000,
        text: 'Sarah joined Acme in 2019',
        words: [],
      },
    });
    return { transcript, speakerA, speakerB, segment };
  }

  async note(opts: { title?: string; versions?: number } = {}) {
    const versions = opts.versions ?? 1;
    const note = await this.prisma.note.create({
      data: {
        ownerId: this.ownerId,
        title: opts.title ?? 'Notes',
        body: 'Body',
        status: 'ready',
        sourceType: 'document',
        currentVersion: versions,
      },
    });
    for (let v = 1; v <= versions; v++) {
      await this.prisma.noteVersion.create({ data: { noteId: note.id, version: v, kind: 'edit', body: `Body v${v}` } });
    }
    return note;
  }
}

/**
 * Bulk: `n` Person entities, each with a stored `type` relation TO `hubId`,
 * all with evidence, in ONE transaction (fast enough for a 1,000-edge hub).
 */
export async function bulkStar(prisma: PrismaClient, ownerId: string, hubId: string, n: number, type = 'DISCUSSED') {
  await prisma.$transaction([
    prisma.$executeRaw`CREATE TEMP TABLE IF NOT EXISTS _star (id uuid) ON COMMIT DROP`,
    prisma.$executeRaw`INSERT INTO _star SELECT gen_random_uuid() FROM generate_series(1, ${n}::int)`,
    prisma.$executeRaw`INSERT INTO kg_entities (id, owner_id, type, label, props, review_status, ontology_version, updated_at)
      SELECT id, ${ownerId}::uuid, 'Person', 'Spoke ' || id::text, '{}'::jsonb, 'accepted', '1.0.0', now() FROM _star`,
    prisma.$executeRaw`INSERT INTO kg_evidence (id, owner_id, subject_kind, subject_id, quote)
      SELECT gen_random_uuid(), ${ownerId}::uuid, 'entity', id, 'q' FROM _star`,
    prisma.$executeRaw`INSERT INTO kg_relations (id, owner_id, type, from_id, to_id, props, review_status, ontology_version, updated_at)
      SELECT id, ${ownerId}::uuid, ${type}, s.sid, ${hubId}::uuid, '{}'::jsonb, 'accepted', '1.0.0', now()
      FROM (SELECT gen_random_uuid() AS id, id AS sid FROM _star) s`,
    prisma.$executeRaw`INSERT INTO kg_evidence (id, owner_id, subject_kind, subject_id, quote)
      SELECT gen_random_uuid(), ${ownerId}::uuid, 'relation', r.id, 'q' FROM kg_relations r
      WHERE r.owner_id = ${ownerId}::uuid AND r.to_id = ${hubId}::uuid
        AND NOT EXISTS (SELECT 1 FROM kg_evidence ev WHERE ev.subject_kind = 'relation' AND ev.subject_id = r.id)`,
  ]);
}

/**
 * The perf fixture: `entities` Persons and `relationsPerEntity × entities`
 * stored relations between them (a deterministic pseudo-random graph), all
 * with evidence, for one owner. Returns one entity id to seed from.
 */
export async function bulkRandomGraph(
  prisma: PrismaClient,
  ownerId: string,
  entities: number,
  relationsPerEntity: number,
): Promise<string> {
  await prisma.$transaction(
    [
      prisma.$executeRaw`CREATE TEMP TABLE IF NOT EXISTS _perf (rn int, id uuid) ON COMMIT DROP`,
      prisma.$executeRaw`INSERT INTO _perf SELECT g, gen_random_uuid() FROM generate_series(1, ${entities}::int) g`,
      prisma.$executeRaw`INSERT INTO kg_entities (id, owner_id, type, label, props, review_status, ontology_version, updated_at)
        SELECT id, ${ownerId}::uuid, CASE WHEN rn % 10 = 0 THEN 'Organization' ELSE 'Person' END, 'Perf ' || rn,
               '{}'::jsonb, 'accepted', '1.0.0', now() FROM _perf`,
      prisma.$executeRaw`INSERT INTO kg_evidence (id, owner_id, subject_kind, subject_id, quote)
        SELECT gen_random_uuid(), ${ownerId}::uuid, 'entity', id, 'q' FROM _perf`,
      prisma.$executeRaw`INSERT INTO kg_relations (id, owner_id, type, from_id, to_id, props, review_status, ontology_version, updated_at)
        SELECT gen_random_uuid(), ${ownerId}::uuid, 'DISCUSSED', a.id, b.id, '{}'::jsonb, 'accepted', '1.0.0', now()
        FROM _perf a
        CROSS JOIN generate_series(1, ${relationsPerEntity}::int) k
        JOIN _perf b ON b.rn = ((a.rn * 7919 + k * 104729) % ${entities}::int) + 1
        WHERE b.id <> a.id`,
      prisma.$executeRaw`INSERT INTO kg_evidence (id, owner_id, subject_kind, subject_id, quote)
        SELECT gen_random_uuid(), ${ownerId}::uuid, 'relation', r.id, 'q' FROM kg_relations r WHERE r.owner_id = ${ownerId}::uuid`,
    ],
  );
  const [row] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM kg_entities WHERE owner_id = ${ownerId}::uuid AND label = 'Perf 4242'`;
  return row.id;
}

// =============================================================================
// ProposalCommitService (#366, epic #346; docs/specs/ontology.md §3.3, §7, §8)
// =============================================================================
//
// "Send to graph": the ONLY general write path from a proposal into the graph,
// and the transaction that enforces the no-orphans invariant (§3.3).
//
// ONE SERIALIZABLE TRANSACTION, IN THIS ORDER:
//   1. lock the proposal (`FOR UPDATE`); it must be `draft`
//   2. validate every accepted/edited/merge_into row's EFFECTIVE payload —
//      effective schema, closed props, endpoint typing, endpoints accepted,
//      link/merge targets still there. Any failure → 400 naming each row,
//      nothing written
//   3. entities: link (`resolution.ref` / `merge_into`: evidence + a learned
//      alias on the existing entity) or create; build `ref → entityId`
//   4. relations (`known` → evidence on the target), then items per #365's
//      commit-semantics table (`known` / `same` append evidence, `same` on a
//      commitment applies its status/due changes, `supersedes` inserts and
//      retires the target, `new` inserts; a live duplicate by statement hash
//      is "known, skipped" — evidence attaches there)
//   5. closings (#365): the target edge's `valid` closes at `closeAt`,
//      `superseded_by_id` → the closing relation; skipped when that relation
//      was not committed
//   6. evidence: every created row gets its proposal-item evidence copied by
//      `GraphWriteService`; every link/known/same appends it
//   7. THE NO-ORPHANS ASSERTION: every entity/relation/item this transaction
//      created or linked is counted in `kg_evidence` INSIDE the transaction;
//      a zero throws (500, full rollback). A row about to be created with no
//      citations at all throws the same error before it is written. This is
//      the §3.3 enforcement point — never a background sweep; the deferred
//      `kg_assert_has_evidence` trigger is the database's backstop behind it
//   8. learning: distinct pairs, `kg_mentions` for every entity touched
//   9. `resolution` proposals: `merge_into` / accepted suggestions →
//      `MergeService.merge` (curated-survivor rule), `reject` → a distinct pair
//  10. `committed_ref_id`, `status = committed`, `committed_at`,
//      `stats.commit`, and `commit_log` — the internal undo record the revert
//      reads (never serialized to clients)
//
// AFTER the transaction, never throwing into the response: `kg.embed` and
// `kg.entity_digest` enqueues — each ONLY while its handler is registered, the
// digest also only while `ai.graphEnabled` — the audit row, and the log line.
//
// A concurrent second commit waits on the row lock, then either reads the
// proposal as `committed` (409 `proposal_not_draft`) or fails serialization;
// a serialization failure is retried, and the retry reads the same 409.
//
// ⚠ Ids and counts only in logs and audit meta, never a label or a quote.
// =============================================================================

import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma, type KgProposal } from '@prisma/client';
import type { EffectiveSchema } from '@app/shared/ontology';
import { z } from 'zod';

import { AiSettingsService } from '../../ai/ai-settings.service';
import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GraphAccessService } from '../access/graph-access.service';
import type { EvidenceInput } from '../dto/graph-evidence.dto';
import {
  KG_EMBED_JOB_TYPE,
  KG_ENTITY_DIGEST_JOB_TYPE,
  KG_SUBJECT_ENTITY,
  KG_SUBJECT_USER,
} from '../job-types';
import { GraphOntologyService } from '../ontology/graph-ontology.service';
import { AliasLearningService } from '../resolution/alias-learning.service';
import { DistinctPairService } from '../resolution/distinct-pair.service';
import { MergeService, type MergeInput, type MergeResult } from '../resolution/merge.service';
import { fromPgRange, rangeFromPrecision, type ValidRange } from '../temporal';
import {
  GraphDuplicateError,
  GraphInvariantError,
  GraphValidationError,
  toGraphHttpException,
} from '../write/graph-write.errors';
import { GraphWriteService } from '../write/graph-write.service';
import {
  COMMIT_ISSUE_CODES,
  type CommitResponse,
  type CommitResult,
} from './dto/proposal.dto';
import type { EndpointRef, EntityPayload, ItemPayload, RelationPayload } from './proposal-payload.schema';
import {
  committedValidity,
  itemTypeFor,
  relationIsOpenEnded,
  validateEntityPayload,
  validateItemPayload,
  validateRelationPayload,
  type PayloadIssue,
} from './proposal-validation';
import {
  asObject,
  effectivePayloadOf,
  type ProposalItemRowInput,
} from './proposal-view.mapper';
import { KG_PROPOSAL_TARGET_TYPE, lockProposal, notDraft, ProposalsService } from './proposals.service';

type Tx = Prisma.TransactionClient;
type Json = Record<string, unknown>;

export const GRAPH_PROPOSAL_COMMITTED_ACTION = 'graph.proposal_committed';
export const KG_EMBED_BATCH = 128;
const LIVE = ['accepted', 'edited'] as const;
const ACTIVE = new Set(['accept', 'edit', 'merge_into']);
const MAX_ATTEMPTS = 3;

// -----------------------------------------------------------------------------
// #365's payload fields, read tolerantly
// -----------------------------------------------------------------------------
//
// #365 (parallel) adds `dedup` to item/relation payloads and replaces the
// `closing` placeholder in `proposal-payload.schema.ts`. The commit reads them
// through these local, tolerant schemas so it never depends on the order the
// two land in: an absent `dedup` is `new`, exactly as #365 defines it.

const isoDate = z.iso.date();

export const itemDedupSchema = z
  .object({
    verdict: z.enum(['same', 'new', 'supersedes', 'known']),
    targetItemId: z.guid().nullable().default(null),
    changes: z
      .object({
        status: z.enum(['open', 'done', 'dropped']).optional(),
        dueAt: isoDate.nullable().optional(),
      })
      .default({}),
  })
  .passthrough();

export const relationDedupSchema = z
  .object({
    verdict: z.enum(['known', 'new']),
    targetRelationId: z.guid().nullable().default(null),
  })
  .passthrough();

export const closingCommitSchema = z
  .object({
    relationId: z.guid(),
    relationType: z.string(),
    closeAt: isoDate,
    precision: z.enum(['day', 'month', 'year']),
    closedByRef: z.string().min(1),
  })
  .passthrough();

function readDedup<T>(schema: z.ZodType<T>, payload: Json): T | null {
  if (payload.dedup === null || payload.dedup === undefined) return null;
  const parsed = schema.safeParse(payload.dedup);
  return parsed.success ? parsed.data : null;
}

// -----------------------------------------------------------------------------
// The commit log
// -----------------------------------------------------------------------------

export interface ItemState {
  status: string;
  dueAt: string | null;
  reviewStatus: string;
  supersededById: string | null;
}

export interface RelationState {
  /** The `tstzrange` literal as Postgres prints it, or null. */
  valid: string | null;
  validPrecision: string | null;
  supersededById: string | null;
}

/**
 * `kg_proposals.commit_log` — the Contract's shape, plus two additive fields
 * the revert needs: `createdEvidence` (the citations written WITH created
 * rows, so "evidence since" can be told apart from this commit's own) and the
 * `after` state of every item change and closing (so "edited since" compares
 * against what this commit wrote rather than guessing).
 */
export interface CommitLog {
  created: { entities: string[]; relations: string[]; items: string[] };
  createdEvidence: string[];
  evidenceAdded: string[];
  aliasesAdded: string[];
  distinctPairs: Array<[string, string]>;
  mentions: string[];
  merges: string[];
  itemChanges: Array<{ itemId: string; before: ItemState; after: ItemState }>;
  closings: Array<{ relationId: string; before: RelationState; after: RelationState }>;
}

export function emptyCommitLog(): CommitLog {
  return {
    created: { entities: [], relations: [], items: [] },
    createdEvidence: [],
    evidenceAdded: [],
    aliasesAdded: [],
    distinctPairs: [],
    mentions: [],
    merges: [],
    itemChanges: [],
    closings: [],
  };
}

export function emptyCommitResult(): CommitResult {
  return {
    created: { entities: 0, relations: 0, items: 0 },
    linked: 0,
    evidenceAdded: 0,
    closingsApplied: 0,
    closingsSkipped: 0,
    superseded: 0,
    aliasesAdded: 0,
    distinctPairsRecorded: 0,
    skippedPending: 0,
  };
}

/** A proposal row that cannot be committed as it stands — every one is reported, then nothing is written. */
export class CommitRowError extends Error {
  constructor(readonly rows: Array<{ itemId: string; issues: PayloadIssue[] }>) {
    super('Some rows cannot be sent to your graph.');
    this.name = 'CommitRowError';
  }
}

export function isSerializationFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    code?: unknown;
    message?: unknown;
    meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; kind?: unknown } } };
    cause?: { originalCode?: unknown; code?: unknown };
  };
  if (e.code === 'P2034') return true;
  const codes = [e.meta?.code, e.meta?.driverAdapterError?.cause?.originalCode, e.cause?.originalCode, e.cause?.code];
  if (codes.some((c) => c === '40001' || c === '40P01')) return true;
  if (e.meta?.driverAdapterError?.cause?.kind === 'TransactionWriteConflict') return true;
  const message = typeof e.message === 'string' ? e.message : '';
  return /could not serialize access|deadlock detected|write conflict/i.test(message);
}

interface CommitOutcome {
  result: CommitResult;
  log: CommitLog;
  noteId: string | null;
  /** Entities created or linked — `kg.embed` and the digest. */
  touchedEntities: string[];
  /** Items created or changed — `kg.embed`. */
  touchedItems: string[];
  merges: MergeResult[];
}

/** The proposal-item evidence rows, as `GraphWriteService` takes them. */
function toEvidenceInputs(
  rows: ReadonlyArray<{
    transcriptId: string | null;
    segmentId: string | null;
    segmentRev: number | null;
    startMs: number | null;
    endMs: number | null;
    noteId: string | null;
    noteVersion: number | null;
    charStart: number | null;
    charEnd: number | null;
    quote: string;
    importObjectId: string | null;
    sourceIri: string | null;
  }>,
): EvidenceInput[] {
  return rows.map((e) => ({
    transcriptId: e.transcriptId,
    segmentId: e.segmentId,
    segmentRev: e.segmentRev,
    startMs: e.startMs,
    endMs: e.endMs,
    noteId: e.noteId,
    noteVersion: e.noteVersion,
    charStart: e.charStart,
    charEnd: e.charEnd,
    quote: e.quote,
    importObjectId: e.importObjectId,
    sourceIri: e.sourceIri,
  }));
}

const toDate = (iso: string | null | undefined): Date | null => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00.000Z`) : null);

@Injectable()
export class ProposalCommitService {
  private readonly logger = new Logger(ProposalCommitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GraphAccessService,
    private readonly ontology: GraphOntologyService,
    private readonly write: GraphWriteService,
    private readonly aliases: AliasLearningService,
    private readonly distinct: DistinctPairService,
    private readonly merges: MergeService,
    private readonly jobs: JobsService,
    private readonly registry: JobHandlerRegistry,
    private readonly aiSettings: AiSettingsService,
    private readonly proposals: ProposalsService,
  ) {}

  async commit(user: RequestUser, proposalId: string): Promise<CommitResponse> {
    await this.access.require(user.id, 'proposal', proposalId, 'edit', user.permissions);
    const schema = await this.ontology.effectiveSchemaFor(user.id);
    const started = Date.now();

    let outcome: CommitOutcome | undefined;
    for (let attempt = 1; outcome === undefined; attempt += 1) {
      try {
        outcome = await this.prisma.$transaction((tx) => this.commitIn(tx, user.id, proposalId, schema), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 60_000,
          maxWait: 10_000,
        });
      } catch (err) {
        if (attempt < MAX_ATTEMPTS && isSerializationFailure(err)) continue;
        throw this.toHttp(err);
      }
    }

    await this.afterCommit(user.id, proposalId, outcome);
    this.logger.log(
      `kg.commit proposal=${proposalId} created=${JSON.stringify(outcome.result.created)} ` +
        `linked=${outcome.result.linked} ms=${Date.now() - started}`,
    );
    return { proposal: await this.proposals.summary(proposalId), result: outcome.result };
  }

  // ===========================================================================
  // The transaction
  // ===========================================================================

  async commitIn(tx: Tx, ownerId: string, proposalId: string, schema: EffectiveSchema): Promise<CommitOutcome> {
    const status = await lockProposal(tx, proposalId);
    if (status !== 'draft') throw notDraft(status);

    const proposal = await tx.kgProposal.findUniqueOrThrow({ where: { id: proposalId } });
    const items = (await tx.kgProposalItem.findMany({
      where: { proposalId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    })) as unknown as Array<ProposalItemRowInput & { id: string }>;
    const evidence = items.length === 0 ? [] : await tx.kgEvidence.findMany({
      where: { ownerId, subjectKind: 'proposal_item', subjectId: { in: items.map((i) => i.id) } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const evidenceOf = (itemId: string) => toEvidenceInputs(evidence.filter((e) => e.subjectId === itemId));

    const run = new CommitRun(ownerId, proposal, items, evidenceOf, schema, tx, {
      write: this.write,
      aliases: this.aliases,
      distinct: this.distinct,
      merges: this.merges,
      logger: this.logger,
    });
    const outcome = proposal.kind === 'resolution' ? await run.resolution() : await run.extraction();

    // 10. Bookkeeping.
    for (const [itemId, refId] of run.committedRefs) {
      await tx.kgProposalItem.update({ where: { id: itemId }, data: { committedRefId: refId } });
    }
    const stats = { ...asObject(proposal.stats), commit: outcome.result };
    await tx.kgProposal.update({
      where: { id: proposalId },
      data: {
        status: 'committed',
        committedAt: new Date(),
        stats: stats as Prisma.InputJsonValue,
        commitLog: outcome.log as unknown as Prisma.InputJsonValue,
      },
    });
    return outcome;
  }

  // ===========================================================================
  // After the transaction
  // ===========================================================================

  private async afterCommit(ownerId: string, proposalId: string, outcome: CommitOutcome): Promise<void> {
    try {
      await this.enqueueEmbeds(ownerId, 'entity', outcome.touchedEntities);
      await this.enqueueEmbeds(ownerId, 'item', outcome.touchedItems);
      await this.enqueueDigests(ownerId, outcome.touchedEntities);
    } catch (err) {
      this.logger.warn(`Follow-up enqueue after committing proposal ${proposalId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const merge of outcome.merges) {
      try {
        await this.merges.afterMerge({ ownerId, actorId: ownerId, source: 'resolution_proposal' }, merge);
      } catch (err) {
        this.logger.warn(`After-merge work for merge ${merge.merge.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: ownerId,
          action: GRAPH_PROPOSAL_COMMITTED_ACTION,
          targetType: KG_PROPOSAL_TARGET_TYPE,
          targetId: proposalId,
          meta: { ...outcome.result, noteId: outcome.noteId } as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.warn(`Audit after committing proposal ${proposalId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** `kg.embed` in batches of ≤ 128 — only while its handler is registered (#364's shape). */
  async enqueueEmbeds(ownerId: string, subjectKind: 'entity' | 'item', ids: readonly string[]): Promise<void> {
    if (ids.length === 0 || !this.registry.get(KG_EMBED_JOB_TYPE)) return;
    for (let i = 0; i < ids.length; i += KG_EMBED_BATCH) {
      await this.jobs.enqueue({
        type: KG_EMBED_JOB_TYPE,
        reason: 'rerun',
        subjectType: KG_SUBJECT_USER,
        subjectId: ownerId,
        skipDedup: true,
        payload: { userId: ownerId, subjectKind, ids: ids.slice(i, i + KG_EMBED_BATCH) },
      });
    }
  }

  /** `kg.entity_digest` per entity — only while registered AND `ai.graphEnabled` (#372's shape). */
  async enqueueDigests(ownerId: string, entityIds: readonly string[]): Promise<void> {
    if (entityIds.length === 0 || !this.registry.get(KG_ENTITY_DIGEST_JOB_TYPE)) return;
    const policy = (await this.aiSettings.get()) as { graphEnabled?: unknown };
    if (policy.graphEnabled !== true) return;
    for (const entityId of entityIds) {
      await this.jobs.enqueue({
        type: KG_ENTITY_DIGEST_JOB_TYPE,
        reason: 'backfill',
        subjectType: KG_SUBJECT_ENTITY,
        subjectId: entityId,
        payload: { entityId, ownerId },
      });
    }
  }

  private toHttp(err: unknown): unknown {
    if (err instanceof HttpException) return err;
    if (err instanceof CommitRowError) {
      return new BadRequestException({ message: err.message, details: { items: err.rows } });
    }
    return toGraphHttpException(err, this.logger) ?? err;
  }
}

// =============================================================================
// One commit run — the state of a single transaction attempt
// =============================================================================

interface RunDeps {
  write: GraphWriteService;
  aliases: AliasLearningService;
  distinct: DistinctPairService;
  merges: MergeService;
  logger: Logger;
}

type Row = ProposalItemRowInput & { id: string };

class CommitRun {
  readonly result = emptyCommitResult();
  readonly log = emptyCommitLog();
  /** Proposal item id → the graph row it became (or was linked to). */
  readonly committedRefs = new Map<string, string>();
  private readonly refMap = new Map<string, string>();
  private readonly relationByRef = new Map<string, string>();
  private readonly touchedEntities = new Set<string>();
  private readonly touchedItems = new Set<string>();
  private readonly mergeResults: MergeResult[] = [];
  private entityTypes = new Map<string, string>();

  constructor(
    private readonly ownerId: string,
    private readonly proposal: KgProposal,
    private readonly items: Row[],
    private readonly evidenceOf: (itemId: string) => EvidenceInput[],
    private readonly schema: EffectiveSchema,
    private readonly tx: Tx,
    private readonly deps: RunDeps,
  ) {}

  // ---------------------------------------------------------------------------
  // Extraction / import proposals
  // ---------------------------------------------------------------------------

  async extraction(): Promise<CommitOutcome> {
    this.result.skippedPending = this.items.filter((i) => i.decision === 'pending').length;
    const active = this.items.filter((i) => ACTIVE.has(i.decision));
    await this.loadEntityTypes(active);

    // 2. Validate everything first; nothing is written unless every row passes.
    const validated = this.validate(active);

    // 3. Entities (the Meeting row included).
    for (const row of active.filter((r) => r.kind === 'entity')) {
      await this.commitEntity(row, validated.get(row.id) as EntityPayload);
    }
    // 4. Relations, then items.
    for (const row of active.filter((r) => r.kind === 'relation')) {
      await this.commitRelation(row, validated.get(row.id) as RelationPayload);
    }
    for (const row of active.filter((r) => r.kind === 'item')) {
      await this.commitItem(row, validated.get(row.id) as ItemPayload);
    }
    // 5. Closings.
    for (const row of active.filter((r) => r.kind === 'closing')) {
      await this.commitClosing(row);
    }

    await this.recordCreatedEvidence();
    // 7. The §3.3 enforcement point.
    await this.assertNoOrphans();
    // 8. Learning: mentions.
    await this.recordMentions();

    return this.outcome();
  }

  // ---------------------------------------------------------------------------
  // Resolution proposals (#364's bulk re-scan)
  // ---------------------------------------------------------------------------

  async resolution(): Promise<CommitOutcome> {
    const rows = this.items.filter((i) => i.kind === 'entity');
    this.result.skippedPending = this.items.filter((i) => i.decision === 'pending').length;
    const ids = rows.flatMap((r) => {
      const res = asObject(r.resolution);
      const eff = effectivePayloadOf(r);
      return [eff.existingEntityId, res.ref, r.mergeIntoId].filter((v): v is string => typeof v === 'string');
    });
    const live = await this.tx.kgEntity.findMany({
      where: { id: { in: [...new Set(ids)] }, ownerId: this.ownerId, reviewStatus: { in: [...LIVE, 'unreviewed'] }, mergedIntoId: null },
      select: { id: true, type: true },
    });
    const liveType = new Map(live.map((e) => [e.id.toLowerCase(), e.type]));

    const plan: Array<{ row: Row; mergedId: string; survivorId: string }> = [];
    const problems: Array<{ itemId: string; issues: PayloadIssue[] }> = [];
    for (const row of rows) {
      if (!ACTIVE.has(row.decision)) continue;
      const existing = effectivePayloadOf(row).existingEntityId;
      const target = row.decision === 'merge_into' ? row.mergeIntoId : (asObject(row.resolution).ref as string | null | undefined) ?? null;
      const existingType = typeof existing === 'string' ? liveType.get(existing.toLowerCase()) : undefined;
      const targetType = target ? liveType.get(target.toLowerCase()) : undefined;
      if (typeof existing !== 'string' || !target || existingType === undefined || targetType === undefined || existingType !== targetType) {
        problems.push({
          itemId: row.id,
          issues: [{ path: 'mergeIntoId', code: COMMIT_ISSUE_CODES.MERGE_TARGET_GONE, message: 'One of the two entities is no longer in your graph.' }],
        });
        continue;
      }
      plan.push({ row, mergedId: existing, survivorId: target });
    }
    if (problems.length > 0) throw new CommitRowError(problems);

    const merged = new Set<string>();
    for (const { row, mergedId, survivorId } of plan) {
      // Two suggestions can chain (A→B, then B→C); a side merged away earlier in this run is skipped.
      if (merged.has(mergedId.toLowerCase()) || merged.has(survivorId.toLowerCase())) continue;
      const input: MergeInput = { ownerId: this.ownerId, mergedId, survivorId, actorId: this.ownerId, source: 'resolution_proposal' };
      const res = await this.deps.merges.merge(input, this.tx);
      merged.add(res.merge.mergedId.toLowerCase());
      this.mergeResults.push(res);
      this.log.merges.push(res.merge.id);
      this.result.linked += 1;
      this.committedRefs.set(row.id, res.merge.survivorId);
      this.touchedEntities.add(res.merge.survivorId);
      await this.recordDistinct(res.merge.survivorId, row.distinctFrom);
    }

    // A rejected suggestion: "not the same" as its top candidate (§7).
    for (const row of rows.filter((r) => r.decision === 'reject')) {
      const existing = effectivePayloadOf(row).existingEntityId;
      const res = asObject(row.resolution);
      const candidates = Array.isArray(res.candidates) ? (res.candidates as Array<{ entityId?: unknown }>) : [];
      const top = typeof res.ref === 'string' ? res.ref : typeof candidates[0]?.entityId === 'string' ? (candidates[0].entityId as string) : null;
      if (typeof existing !== 'string' || !top) continue;
      await this.recordDistinct(existing, [top]);
    }
    return this.outcome();
  }

  // ---------------------------------------------------------------------------
  // Validation (step 2)
  // ---------------------------------------------------------------------------

  private async loadEntityTypes(active: Row[]): Promise<void> {
    const ids = new Set<string>();
    for (const row of active) {
      const eff = effectivePayloadOf(row);
      for (const key of ['from', 'to', 'subject', 'owner', 'counterparty', 'meeting']) {
        const id = asObject(eff[key]).entityId;
        if (typeof id === 'string') ids.add(id.toLowerCase());
      }
      const ref = asObject(row.resolution).ref;
      if (row.kind === 'entity' && typeof ref === 'string') ids.add(ref.toLowerCase());
      if (row.mergeIntoId) ids.add(row.mergeIntoId.toLowerCase());
    }
    if (ids.size === 0) return;
    const rows = await this.tx.kgEntity.findMany({
      where: { id: { in: [...ids] }, ownerId: this.ownerId, reviewStatus: { in: [...LIVE] }, mergedIntoId: null },
      select: { id: true, type: true },
    });
    this.entityTypes = new Map(rows.map((r) => [r.id.toLowerCase(), r.type]));
  }

  private validate(active: Row[]): Map<string, unknown> {
    const byRef = new Map<string, Row>();
    for (const row of this.items) {
      if (row.kind !== 'entity') continue;
      const ref = effectivePayloadOf(row).ref;
      if (typeof ref === 'string') byRef.set(ref, row);
    }
    const typeOf = (e: EndpointRef): string | undefined => {
      if ('ref' in e) {
        const row = byRef.get(e.ref);
        const type = row ? effectivePayloadOf(row).type : undefined;
        return typeof type === 'string' ? type : undefined;
      }
      return this.entityTypes.get(e.entityId.toLowerCase());
    };

    const out = new Map<string, unknown>();
    const problems: Array<{ itemId: string; issues: PayloadIssue[] }> = [];
    for (const row of active) {
      const eff = effectivePayloadOf(row);
      const issues: PayloadIssue[] = [];
      if (row.kind === 'entity') {
        const v = validateEntityPayload(eff, this.schema);
        if (!v.ok) issues.push(...v.issues);
        else out.set(row.id, v.value);
        const type = typeof eff.type === 'string' ? eff.type : '';
        if (row.decision === 'merge_into') {
          const t = row.mergeIntoId ? this.entityTypes.get(row.mergeIntoId.toLowerCase()) : undefined;
          if (t === undefined) {
            issues.push({ path: 'mergeIntoId', code: COMMIT_ISSUE_CODES.MERGE_TARGET_GONE, message: 'The entity this row was merged into is no longer in your graph.' });
          } else if (t !== type) {
            issues.push({ path: 'mergeIntoId', code: COMMIT_ISSUE_CODES.INVALID, message: `The entity this row was merged into is a ${t}, not a ${type}.` });
          }
        } else {
          const ref = asObject(row.resolution).ref;
          if (typeof ref === 'string') {
            const t = this.entityTypes.get(ref.toLowerCase());
            if (t === undefined) {
              issues.push({ path: 'resolution.ref', code: COMMIT_ISSUE_CODES.LINK_TARGET_GONE, message: 'The entity this row links to is no longer in your graph.' });
            } else if (t !== type) {
              issues.push({ path: 'resolution.ref', code: COMMIT_ISSUE_CODES.INVALID, message: `The linked entity is a ${t}, not a ${type}.` });
            }
          }
        }
      } else if (row.kind === 'relation' || row.kind === 'item') {
        const v =
          row.kind === 'relation'
            ? validateRelationPayload(eff, this.schema, typeOf)
            : validateItemPayload(eff, this.schema, typeOf);
        if (!v.ok) issues.push(...v.issues);
        else out.set(row.id, v.value);
        const fields = row.kind === 'relation' ? ['from', 'to'] : ['subject', 'owner', 'counterparty', 'meeting'];
        for (const field of fields) {
          const ref = asObject(eff[field]).ref;
          if (typeof ref !== 'string') continue;
          const target = byRef.get(ref);
          if (!target || !ACTIVE.has(target.decision)) {
            issues.push({ path: field, code: COMMIT_ISSUE_CODES.ENDPOINT_NOT_ACCEPTED, message: 'This row names an entity row that is not accepted.' });
          }
        }
      } else {
        const v = closingCommitSchema.safeParse(eff);
        if (!v.success) {
          issues.push(...v.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message, code: COMMIT_ISSUE_CODES.INVALID })));
        }
      }
      if (issues.length > 0) problems.push({ itemId: row.id, issues });
    }
    if (problems.length > 0) throw new CommitRowError(problems);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Writes (steps 3–5)
  // ---------------------------------------------------------------------------

  private async commitEntity(row: Row, payload: EntityPayload): Promise<void> {
    const evidence = this.evidenceOf(row.id);
    const linkTarget =
      row.decision === 'merge_into'
        ? row.mergeIntoId
        : typeof asObject(row.resolution).ref === 'string'
          ? (asObject(row.resolution).ref as string)
          : null;

    let entityId: string;
    if (linkTarget) {
      entityId = linkTarget;
      this.result.linked += 1;
      await this.appendEvidence('entity', entityId, evidence);
      // §7 learning: a confirmed link teaches the proposed label as an alias.
      const aliasId = await this.deps.aliases.recordLink(this.tx, entityId, payload.label, 'extraction');
      if (aliasId) {
        this.log.aliasesAdded.push(aliasId);
        this.result.aliasesAdded += 1;
      }
    } else {
      this.requireCitations('entity', row, evidence);
      const entity = await this.guard(row, () =>
        this.deps.write.createEntity(
          this.tx,
          {
            ownerId: this.ownerId,
            type: payload.type,
            label: payload.label,
            props: payload.props,
            occurredAt: toDate(payload.occurredAt),
            reviewStatus: row.editedPayload ? 'edited' : 'accepted',
            aliases: payload.aliases.map((alias) => ({ alias, source: 'extraction' as const })),
            labelSource: row.origin === 'user' ? 'user' : 'extraction',
            evidence,
          },
          this.schema,
        ),
      );
      entityId = entity.id;
      this.log.created.entities.push(entityId);
      this.result.created.entities += 1;
    }
    this.refMap.set(payload.ref, entityId);
    this.committedRefs.set(row.id, entityId);
    this.touchedEntities.add(entityId);
    await this.recordDistinct(entityId, row.distinctFrom);
  }

  private async commitRelation(row: Row, payload: RelationPayload): Promise<void> {
    const evidence = this.evidenceOf(row.id);
    const dedup = readDedup(relationDedupSchema, effectivePayloadOf(row));
    if (dedup?.verdict === 'known' && dedup.targetRelationId) {
      const target = await this.tx.kgRelation.findFirst({
        where: { id: dedup.targetRelationId, ownerId: this.ownerId, reviewStatus: { in: [...LIVE] } },
        select: { id: true },
      });
      if (target) {
        await this.appendEvidence('relation', target.id, evidence);
        this.relationByRef.set(payload.ref, target.id);
        this.committedRefs.set(row.id, target.id);
        return;
      }
    }

    this.requireCitations('relation', row, evidence);
    const spec = this.schema.relationType(payload.type)!;
    const validity = committedValidity(payload, { temporal: spec.temporal, openEnded: relationIsOpenEnded(this.schema, payload.type) });
    const relation = await this.guard(row, () =>
      this.deps.write.createRelation(
        this.tx,
        {
          ownerId: this.ownerId,
          type: payload.type,
          fromId: this.resolve(payload.from),
          toId: this.resolve(payload.to),
          props: payload.props,
          valid: validity.valid,
          validPrecision: validity.validPrecision,
          reviewStatus: row.editedPayload ? 'edited' : 'accepted',
          evidence,
        },
        this.schema,
      ),
    );
    this.log.created.relations.push(relation.id);
    this.result.created.relations += 1;
    this.relationByRef.set(payload.ref, relation.id);
    this.committedRefs.set(row.id, relation.id);
  }

  private async commitItem(row: Row, payload: ItemPayload): Promise<void> {
    const evidence = this.evidenceOf(row.id);
    const dedup = readDedup(itemDedupSchema, effectivePayloadOf(row));
    const target = dedup?.targetItemId
      ? await this.tx.kgItem.findFirst({
          where: { id: dedup.targetItemId, ownerId: this.ownerId, reviewStatus: { in: [...LIVE] } },
        })
      : null;

    // `known` / `same`: the fact is already there — cite it again.
    if (target && (dedup?.verdict === 'known' || dedup?.verdict === 'same')) {
      await this.appendEvidence('item', target.id, evidence);
      this.committedRefs.set(row.id, target.id);
      const changes = dedup.changes ?? {};
      if (dedup.verdict === 'same' && target.kind === 'commitment' && (changes.status !== undefined || changes.dueAt !== undefined)) {
        const before = itemState(target);
        const updated = await this.guard(row, () =>
          this.deps.write.updateItemState(
            this.tx,
            this.ownerId,
            target.id,
            {
              ...(changes.status !== undefined ? { status: changes.status } : {}),
              ...(changes.dueAt !== undefined ? { dueAt: toDate(changes.dueAt) } : {}),
            },
            this.schema,
          ),
        );
        this.log.itemChanges.push({ itemId: target.id, before, after: itemState(updated) });
        this.touchedItems.add(target.id);
      }
      return;
    }

    this.requireCitations('item', row, evidence);
    const supersedesId = dedup?.verdict === 'supersedes' && target ? target.id : null;
    const type = itemTypeFor(this.schema, payload.kind)!;
    const validity = committedValidity(payload, { temporal: true, openEnded: false });
    let created;
    try {
      created = await this.deps.write.createItem(
        this.tx,
        {
          ownerId: this.ownerId,
          kind: payload.kind,
          typeKey: type.key,
          subjectId: payload.subject ? this.resolve(payload.subject) : null,
          meetingId: payload.meeting ? this.resolve(payload.meeting) : null,
          ownerPersonId: payload.owner ? this.resolve(payload.owner) : null,
          counterpartyId: payload.counterparty ? this.resolve(payload.counterparty) : null,
          title: payload.title,
          statement: payload.statement,
          ...(payload.status !== null ? { status: payload.status } : {}),
          occurredAt: toDate(payload.occurredAt),
          dueAt: toDate(payload.dueAt),
          sensitivity: payload.sensitivity,
          props: payload.props,
          valid: validity.valid,
          validPrecision: validity.validPrecision,
          reviewStatus: row.editedPayload ? 'edited' : 'accepted',
          supersedesId,
          evidence,
        },
        this.schema,
      );
    } catch (err) {
      // "Known, skipped" (§8): a live item with the same statement already exists.
      if (err instanceof GraphDuplicateError && err.existingId) {
        await this.appendEvidence('item', err.existingId, evidence);
        this.committedRefs.set(row.id, err.existingId);
        return;
      }
      throw this.rowError(row, err);
    }
    if (supersedesId && target) {
      const after = await this.tx.kgItem.findUniqueOrThrow({ where: { id: supersedesId } });
      this.log.itemChanges.push({ itemId: supersedesId, before: itemState(target), after: itemState(after) });
      this.result.superseded += 1;
    }
    this.log.created.items.push(created.id);
    this.result.created.items += 1;
    this.touchedItems.add(created.id);
    this.committedRefs.set(row.id, created.id);
  }

  private async commitClosing(row: Row): Promise<void> {
    const closing = closingCommitSchema.parse(effectivePayloadOf(row));
    const closer = this.items.find(
      (i) => i.kind === 'relation' && effectivePayloadOf(i).ref === closing.closedByRef,
    );
    const closerId = closer && ACTIVE.has(closer.decision) ? this.relationByRef.get(closing.closedByRef) : undefined;
    const skip = () => {
      this.result.closingsSkipped += 1;
    };
    if (!closerId) return skip();

    const [current] = await this.tx.$queryRaw<
      Array<{ id: string; valid: string | null; valid_precision: string | null; superseded_by_id: string | null }>
    >`SELECT id::text AS id, valid::text AS valid, valid_precision::text AS valid_precision,
             superseded_by_id::text AS superseded_by_id
        FROM kg_relations
       WHERE id = ${closing.relationId}::uuid AND owner_id = ${this.ownerId}::uuid
         AND review_status IN ('accepted', 'edited')
       FOR UPDATE`;
    if (!current || current.id.toLowerCase() === closerId.toLowerCase()) return skip();

    const closeAt = rangeFromPrecision(atPrecision(closing.closeAt, closing.precision), null, closing.precision).range!.from!;
    const range: ValidRange | null = current.valid ? fromPgRange(current.valid) : null;
    // Only an OPEN edge that started before the new fact is closed.
    if (range && range.to !== null) return skip();
    if (range?.from && range.from.getTime() >= closeAt.getTime()) return skip();

    const precision =
      current.valid_precision && current.valid_precision !== 'unknown' ? current.valid_precision : closing.precision;
    await this.guard(row, () =>
      this.deps.write.closeRelation(this.tx, this.ownerId, current.id, {
        valid: { from: range?.from ?? null, to: closeAt },
        validPrecision: precision as 'day' | 'month' | 'year',
        supersededById: closerId,
      }),
    );
    const [after] = await this.tx.$queryRaw<
      Array<{ valid: string | null; valid_precision: string | null; superseded_by_id: string | null }>
    >`SELECT valid::text AS valid, valid_precision::text AS valid_precision, superseded_by_id::text AS superseded_by_id
        FROM kg_relations WHERE id = ${current.id}::uuid`;
    this.log.closings.push({
      relationId: current.id,
      before: { valid: current.valid, validPrecision: current.valid_precision, supersededById: current.superseded_by_id },
      after: { valid: after.valid, validPrecision: after.valid_precision, supersededById: after.superseded_by_id },
    });
    this.result.closingsApplied += 1;
    this.committedRefs.set(row.id, current.id);
  }

  // ---------------------------------------------------------------------------
  // Evidence, learning, the assertion
  // ---------------------------------------------------------------------------

  private async appendEvidence(kind: 'entity' | 'relation' | 'item', subjectId: string, evidence: EvidenceInput[]): Promise<void> {
    if (evidence.length === 0) return;
    const rows = await this.deps.write.addEvidence(this.tx, this.ownerId, kind, subjectId, evidence);
    this.log.evidenceAdded.push(...rows.map((r) => r.id));
    this.result.evidenceAdded += rows.length;
  }

  /** A row about to be CREATED with no citations at all is a writer bug (§3.3) — never a 400. */
  private requireCitations(kind: 'entity' | 'relation' | 'item', row: Row, evidence: EvidenceInput[]): void {
    if (evidence.length > 0) return;
    this.deps.logger.error(`no-orphans invariant violated: proposal ${this.proposal.id} ${kind} row ${row.id} has no evidence`);
    throw new Error(`no-orphans invariant violated: ${kind} ${row.id}`);
  }

  private async recordCreatedEvidence(): Promise<void> {
    const { entities, relations, items } = this.log.created;
    const subjects = [
      ...entities.map((id) => ({ subjectKind: 'entity' as const, subjectId: id })),
      ...relations.map((id) => ({ subjectKind: 'relation' as const, subjectId: id })),
      ...items.map((id) => ({ subjectKind: 'item' as const, subjectId: id })),
    ];
    if (subjects.length === 0) return;
    const rows = await this.tx.kgEvidence.findMany({ where: { ownerId: this.ownerId, OR: subjects }, select: { id: true } });
    this.log.createdEvidence = rows.map((r) => r.id);
    this.result.evidenceAdded += rows.length;
  }

  /**
   * Step 7. Every row this transaction created or linked — counted INSIDE the
   * transaction. A zero is a writer bug: log the ids (never content) and roll
   * everything back.
   */
  private async assertNoOrphans(): Promise<void> {
    const subjects: Array<{ kind: 'entity' | 'relation' | 'item'; id: string }> = [
      ...[...this.touchedEntities].map((id) => ({ kind: 'entity' as const, id })),
      ...this.log.created.relations.map((id) => ({ kind: 'relation' as const, id })),
      ...[...this.touchedItems].map((id) => ({ kind: 'item' as const, id })),
      ...[...this.committedRefs.entries()]
        .filter(([itemId]) => this.items.find((i) => i.id === itemId)?.kind === 'relation')
        .map(([, id]) => ({ kind: 'relation' as const, id })),
      ...[...this.committedRefs.entries()]
        .filter(([itemId]) => this.items.find((i) => i.id === itemId)?.kind === 'item')
        .map(([, id]) => ({ kind: 'item' as const, id })),
    ];
    if (subjects.length === 0) return;
    const counts = await this.tx.kgEvidence.groupBy({
      by: ['subjectKind', 'subjectId'],
      where: { OR: subjects.map((s) => ({ subjectKind: s.kind, subjectId: s.id })) },
      _count: { _all: true },
    });
    const have = new Set(counts.filter((c) => c._count._all > 0).map((c) => `${c.subjectKind}:${c.subjectId.toLowerCase()}`));
    const orphan = subjects.find((s) => !have.has(`${s.kind}:${s.id.toLowerCase()}`));
    if (orphan) {
      this.deps.logger.error(`no-orphans invariant violated: proposal ${this.proposal.id} ${orphan.kind} ${orphan.id}`);
      throw new Error(`no-orphans invariant violated: ${orphan.kind} ${orphan.id}`);
    }
  }

  private async recordDistinct(entityId: string, others: readonly string[]): Promise<void> {
    const wanted = [...new Set(others.map((o) => o.toLowerCase()))].filter((o) => o !== entityId.toLowerCase());
    if (wanted.length === 0) return;
    const existing = await this.tx.kgEntity.findMany({
      where: { id: { in: wanted }, ownerId: this.ownerId },
      select: { id: true },
    });
    for (const { id } of existing) {
      const pair = await this.deps.distinct.record(this.tx, this.ownerId, entityId, id);
      if (pair.created) {
        this.log.distinctPairs.push([pair.aId, pair.bId]);
        this.result.distinctPairsRecorded += 1;
      }
    }
  }

  /** A `kg_mentions` row `(note, entity, linked)` for every entity touched, unless one exists. */
  private async recordMentions(): Promise<void> {
    const noteId = this.proposal.noteId;
    if (!noteId || this.touchedEntities.size === 0) return;
    const entityIds = [...this.touchedEntities];
    const existing = await this.tx.kgMention.findMany({
      where: { ownerId: this.ownerId, noteId, entityId: { in: entityIds } },
      select: { entityId: true },
    });
    const have = new Set(existing.map((m) => m.entityId.toLowerCase()));
    const fresh = entityIds.filter((id) => !have.has(id.toLowerCase()));
    if (fresh.length === 0) return;
    const rows = await this.tx.kgMention.createManyAndReturn({
      data: fresh.map((entityId) => ({ ownerId: this.ownerId, entityId, noteId, status: 'linked' as const })),
      select: { id: true },
    });
    this.log.mentions.push(...rows.map((r) => r.id));
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private resolve(endpoint: EndpointRef): string {
    if ('entityId' in endpoint) return endpoint.entityId;
    const id = this.refMap.get(endpoint.ref);
    if (!id) {
      // Validation proved every ref'd row is accepted and entities commit first.
      throw new CommitRowError([
        { itemId: 'unknown', issues: [{ path: endpoint.ref, code: COMMIT_ISSUE_CODES.ENDPOINT_NOT_ACCEPTED, message: 'Unresolved entity reference.' }] },
      ]);
    }
    return id;
  }

  /** A graph write refused on its own terms names the proposal row it came from. */
  private async guard<T>(row: Row, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw this.rowError(row, err);
    }
  }

  private rowError(row: Row, err: unknown): unknown {
    if (err instanceof GraphValidationError) {
      const issues = Array.isArray(err.details.issues)
        ? (err.details.issues as PayloadIssue[])
        : [{ path: '', message: err.message, code: COMMIT_ISSUE_CODES.INVALID }];
      return new CommitRowError([{ itemId: row.id, issues }]);
    }
    if (err instanceof GraphInvariantError) {
      // Every created row was checked for citations first, so this is a writer bug.
      this.deps.logger.error(`no-orphans invariant violated: proposal ${this.proposal.id} row ${row.id} (${err.code})`);
      return new Error(`no-orphans invariant violated: row ${row.id}`);
    }
    if (err instanceof GraphDuplicateError) {
      return new CommitRowError([{ itemId: row.id, issues: [{ path: 'statement', message: err.message, code: COMMIT_ISSUE_CODES.INVALID }] }]);
    }
    return err;
  }

  private outcome(): CommitOutcome {
    return {
      result: this.result,
      log: this.log,
      noteId: this.proposal.noteId,
      touchedEntities: [...this.touchedEntities],
      touchedItems: [...this.touchedItems],
      merges: this.mergeResults,
    };
  }
}

function atPrecision(iso: string, precision: 'day' | 'month' | 'year'): string {
  return precision === 'year' ? iso.slice(0, 4) : precision === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
}

export function itemState(row: { status: string; dueAt: Date | null; reviewStatus: string; supersededById: string | null }): ItemState {
  return {
    status: row.status,
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    reviewStatus: row.reviewStatus,
    supersededById: row.supersededById,
  };
}

// =============================================================================
// ProposalBatchCommitService (#717, epic #708; ADR-0007)
// =============================================================================
//
// The cross-proposal Review Queue and the "commit the safe rows of many drafts"
// action. NO NEW WRITE PATH: decisions go through `ProposalsService.bulk` and the
// graph write through `ProposalCommitService.commit` (which owns the Serializable
// transaction, `GraphWriteService`, the no-orphans assertion and the audit row).
// Each proposal is committed on its own, sequentially; one failure never aborts
// the others.
//
// WHAT COMMIT DOES WITH UNDECIDED ROWS. `commit` ignores `pending` rows
// (`stats.commit.skippedPending`) and marks the WHOLE proposal `committed`, after
// which the rows can no longer be decided. ADR-0007 says the waiting rows "stay in
// the draft for a person", so after a successful commit this service moves them into
// a NEW draft of the same note (`remainderProposalId`): the pending rows keep their
// ids (their evidence follows), and their `{ ref }` endpoints that pointed at an
// entity the commit just wrote become `{ entityId }`. If the note already has another
// draft (one draft per note) the rows stay where they are and the result says so.
//
// ⚠ Logs and audit meta carry ids and counts only.
// =============================================================================

import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  CommitBatchDto,
  CommitBatchResponse,
  CommitBatchResult,
  ReviewQueueGroup,
  ReviewQueueResponse,
} from '@marinoscar/kvox-contract/graph';

import { GraphAccessService, GraphOntologyService, GraphPreferencesService } from '../../graph/index.js';
import type { GraphActor, InputJsonValue, KvoxGraphDb } from '../../graph/index.js';
import { KVOX_AUDIT, KVOX_PRISMA, type KvoxAuditPort } from '../../ports/index.js';
import { Prisma } from '../../core/index.js';
import { reviewOnlyTypes } from '../extraction/precheck.js';
import { ProposalCommitService } from './proposal-commit.service.js';
import { ProposalsService } from './proposals.service.js';
import { asObject, effectivePayloadOf } from './proposal-view.mapper.js';
import { endpointsOf } from './proposal-validation.js';
import { applySafePolicy, type SafePolicyItem, type SafePolicyResult } from './safe-policy.js';

export const GRAPH_PROPOSALS_BATCH_COMMITTED_ACTION = 'graph.proposals_batch_committed';
/** Most proposals one batch / queue request handles. */
export const BATCH_MAX_PROPOSALS = 500;
const BULK_CHUNK = 500;

type Json = Record<string, unknown>;

interface ItemRow {
  id: string;
  kind: 'entity' | 'relation' | 'item' | 'closing';
  decision: SafePolicyItem['decision'];
  payload: unknown;
  editedPayload: unknown;
  resolution: unknown;
  mergeIntoId: string | null;
  flags: string[];
  committedRefId?: string | null;
}

/** Row → the policy's input. Exported for tests. */
export function toPolicyItem(row: ItemRow, reviewOnly: ReadonlySet<string>): SafePolicyItem {
  const eff = effectivePayloadOf(row);
  const res = asObject(row.resolution);
  const hasRes = Object.keys(res).length > 0;
  const adjudication = asObject(res.adjudication);
  const endpointRefs =
    row.kind === 'relation' || row.kind === 'item'
      ? endpointsOf(row.kind, eff).flatMap((e) => ('ref' in e.endpoint && typeof e.endpoint.ref === 'string' ? [e.endpoint.ref] : []))
      : [];
  return {
    id: row.id,
    kind: row.kind,
    decision: row.decision,
    ref: typeof eff.ref === 'string' ? eff.ref : null,
    closedByRef: row.kind === 'closing' && typeof eff.closedByRef === 'string' ? eff.closedByRef : null,
    itemKind: row.kind === 'item' && typeof eff.kind === 'string' ? eff.kind : null,
    sensitivity: typeof eff.sensitivity === 'string' ? eff.sensitivity : null,
    reviewOnly: (row.kind === 'entity' || row.kind === 'relation') && typeof eff.type === 'string' && reviewOnly.has(eff.type),
    flags: row.flags ?? [],
    resolution: hasRes
      ? {
          ref: typeof res.ref === 'string' ? res.ref : null,
          score: typeof res.score === 'number' ? res.score : null,
          adjudication:
            typeof adjudication.verdict === 'string'
              ? { verdict: adjudication.verdict as 'same' | 'different' | 'uncertain' }
              : null,
        }
      : row.mergeIntoId
        ? { ref: row.mergeIntoId, score: null }
        : null,
    endpointRefs,
  };
}

const ITEM_SELECT = {
  id: true,
  kind: true,
  decision: true,
  payload: true,
  editedPayload: true,
  resolution: true,
  mergeIntoId: true,
  flags: true,
} as const;

/**
 * ProposalBatchCommitService: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class ProposalBatchCommitService {
  private readonly logger = new Logger(ProposalBatchCommitService.name);

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    private readonly proposals: ProposalsService,
    private readonly commits: ProposalCommitService,
    private readonly prefs: GraphPreferencesService,
    private readonly ontology: GraphOntologyService,
    private readonly access: GraphAccessService,
    @Inject(KVOX_AUDIT) private readonly audit: KvoxAuditPort,
  ) {}

  // ===========================================================================
  // Review queue
  // ===========================================================================

  /** The caller's open drafts, grouped by library / batch, with safe vs waiting counts. */
  async reviewQueue(user: GraphActor, limit: number = BATCH_MAX_PROPOSALS): Promise<ReviewQueueResponse> {
    const [prefs, schema] = await Promise.all([this.prefs.get(user.id), this.ontology.effectiveSchemaFor(user.id)]);
    const minConfidence = prefs.review.minConfidence;
    const reviewOnly = reviewOnlyTypes(schema);

    const drafts = await this.prisma.kgProposal.findMany({
      where: { ownerId: user.id, status: 'draft', kind: 'extraction' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const truncated = drafts.length > limit;
    const page = drafts.slice(0, limit);
    const noteIds = [...new Set(page.flatMap((p) => (p.noteId ? [p.noteId] : [])))];

    const [notes, rows, batchItems] = await Promise.all([
      noteIds.length ? this.prisma.note.findMany({ where: { id: { in: noteIds } }, select: { id: true, title: true, currentVersion: true } }) : [],
      page.length
        ? this.prisma.kgProposalItem.findMany({ where: { proposalId: { in: page.map((p) => p.id) } }, select: { ...ITEM_SELECT, proposalId: true } })
        : [],
      noteIds.length
        ? this.prisma.noteImportBatchItem.findMany({
            where: { noteId: { in: noteIds }, batch: { ownerId: user.id } },
            select: { batchId: true, noteId: true, noteVersion: true },
          })
        : [],
    ]);
    const batchIds = [...new Set(batchItems.map((b) => b.batchId))];
    const batches = batchIds.length
      ? await this.prisma.noteImportBatch.findMany({ where: { id: { in: batchIds }, ownerId: user.id }, select: { id: true, libraryId: true, createdAt: true } })
      : [];
    const libraryIds = [...new Set(batches.flatMap((b) => (b.libraryId ? [b.libraryId] : [])))];
    const libraries = libraryIds.length
      ? await this.prisma.noteLibrary.findMany({ where: { id: { in: libraryIds }, ownerId: user.id }, select: { id: true, name: true } })
      : [];

    const noteById = new Map(notes.map((n) => [n.id, n]));
    const batchById = new Map(batches.map((b) => [b.id, b]));
    const libraryName = new Map(libraries.map((l) => [l.id, l.name]));
    const rowsByProposal = new Map<string, ItemRow[]>();
    for (const r of rows as unknown as Array<ItemRow & { proposalId: string }>) {
      const list = rowsByProposal.get(r.proposalId) ?? [];
      list.push(r);
      rowsByProposal.set(r.proposalId, list);
    }

    const groups = new Map<string, ReviewQueueGroup>();
    for (const p of page) {
      const note = p.noteId ? noteById.get(p.noteId) : undefined;
      const stale = p.noteId !== null && p.noteVersion !== null && (!note || note.currentVersion > p.noteVersion);
      const items = rowsByProposal.get(p.id) ?? [];
      const policy = applySafePolicy(items.map((r) => toPolicyItem(r, reviewOnly)), { minConfidence });
      const counts = { total: items.length, safe: policy.alreadyAccepted.length + policy.accept.length, waiting: policy.waiting.length };

      // The newest batch that produced this exact note version.
      const batch = batchItems
        .filter((b) => b.noteId === p.noteId && (b.noteVersion === null || b.noteVersion === p.noteVersion))
        .map((b) => batchById.get(b.batchId))
        .filter((b): b is NonNullable<typeof b> => b !== undefined)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      const key = batch
        ? batch.libraryId
          ? { type: 'library' as const, id: batch.libraryId, label: libraryName.get(batch.libraryId) ?? 'Library' }
          : { type: 'batch' as const, id: batch.id, label: `Import ${batch.createdAt.toISOString().slice(0, 10)}` }
        : { type: 'other' as const, id: null, label: 'Individual notes' };
      const gk = `${key.type}:${key.id ?? ''}`;
      let group = groups.get(gk);
      if (!group) {
        group = { key, proposals: [], totals: { proposals: 0, stale: 0, total: 0, safe: 0, waiting: 0 } };
        groups.set(gk, group);
      }
      group.proposals.push({
        proposalId: p.id,
        noteId: p.noteId,
        noteTitle: note?.title ?? null,
        noteVersion: p.noteVersion,
        stale,
        counts,
        createdAt: p.createdAt.toISOString(),
      });
      const t = group.totals;
      t.proposals += 1;
      t.stale += stale ? 1 : 0;
      t.total += counts.total;
      // A stale proposal is never batch-committed, so none of its rows is "safe".
      t.safe += stale ? 0 : counts.safe;
      t.waiting += stale ? counts.total : counts.waiting;
    }

    const ordered = [...groups.values()].sort((a, b) => {
      if ((a.key.type === 'other') !== (b.key.type === 'other')) return a.key.type === 'other' ? 1 : -1;
      return b.proposals[0]!.createdAt.localeCompare(a.proposals[0]!.createdAt);
    });
    const totals = ordered.reduce(
      (acc, g) => ({
        proposals: acc.proposals + g.totals.proposals,
        stale: acc.stale + g.totals.stale,
        total: acc.total + g.totals.total,
        safe: acc.safe + g.totals.safe,
        waiting: acc.waiting + g.totals.waiting,
      }),
      { proposals: 0, stale: 0, total: 0, safe: 0, waiting: 0 },
    );
    return { groups: ordered, totals, minConfidence, truncated };
  }

  // ===========================================================================
  // Commit batch
  // ===========================================================================

  /** Applies the safe policy to every draft in scope and commits each, one at a time. */
  async commitBatch(user: GraphActor, dto: CommitBatchDto): Promise<CommitBatchResponse> {
    const results: CommitBatchResult[] = [];
    const ids = await this.resolveScope(user, dto, results);
    const [prefs, schema] = await Promise.all([this.prefs.get(user.id), this.ontology.effectiveSchemaFor(user.id)]);
    const reviewOnly = reviewOnlyTypes(schema);

    for (const id of ids) {
      results.push(await this.commitSafe(user, id, { minConfidence: prefs.review.minConfidence, reviewOnly }));
    }

    try {
      await this.audit.record({
        actorUserId: user.id,
        action: GRAPH_PROPOSALS_BATCH_COMMITTED_ACTION,
        targetType: 'kg_proposal',
        targetId: ids[0] ?? dto.batchId ?? dto.libraryId ?? user.id,
        meta: {
          scope: dto.batchId ? 'batch' : dto.libraryId ? 'library' : 'proposals',
          proposals: results.length,
          committed: results.filter((r) => r.status === 'committed').length,
          skipped: results.filter((r) => r.status === 'skipped').length,
          failed: results.filter((r) => r.status === 'failed').length,
        },
      });
    } catch (err) {
      this.logger.warn(`Audit after a batch commit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { results };
  }

  /**
   * One proposal: accept the safe rows, commit, keep the rest as a new draft. Never throws
   * (a failure is a `failed` result) so a batch and the `kg.autocommit` job (#718) can loop.
   * `actor` must hold `graph:write`; the caller checks stale-ness is handled here.
   */
  async commitSafe(
    actor: GraphActor,
    proposalId: string,
    opts: { minConfidence?: number; reviewOnly?: ReadonlySet<string> } = {},
  ): Promise<CommitBatchResult> {
    const base = { proposalId, accepted: 0, waiting: 0 };
    try {
      const proposal = await this.prisma.kgProposal.findFirst({ where: { id: proposalId, ownerId: actor.id } });
      if (!proposal) return { ...base, status: 'skipped', reason: 'not_found' };
      if (proposal.status !== 'draft') return { ...base, status: 'skipped', reason: 'not_draft' };
      if (proposal.kind !== 'extraction') return { ...base, status: 'skipped', reason: 'unsupported_kind' };
      if (await this.isStale(proposal)) return { ...base, status: 'skipped', reason: 'stale' };

      // Access (owner + graph:write) before any decision is written.
      await this.access.require(actor.id, 'proposal', proposalId, 'edit', actor.permissions);

      const minConfidence = opts.minConfidence ?? (await this.prefs.get(actor.id)).review.minConfidence;
      const reviewOnly = opts.reviewOnly ?? reviewOnlyTypes(await this.ontology.effectiveSchemaFor(actor.id));
      const rows = (await this.prisma.kgProposalItem.findMany({ where: { proposalId }, select: ITEM_SELECT })) as unknown as ItemRow[];
      const policy = applySafePolicy(rows.map((r) => toPolicyItem(r, reviewOnly)), { minConfidence });

      let newlyAccepted = 0;
      for (let i = 0; i < policy.accept.length; i += BULK_CHUNK) {
        const res = await this.proposals.bulk(actor, proposalId, { itemIds: policy.accept.slice(i, i + BULK_CHUNK), decision: 'accept' });
        newlyAccepted += res.updated;
      }
      const accepted = policy.alreadyAccepted.length + newlyAccepted;
      const waiting = policy.waiting.length + (policy.accept.length - newlyAccepted);
      if (accepted === 0) return { ...base, waiting, status: 'skipped', reason: 'nothing_to_commit' };

      await this.commits.commit(actor, proposalId);

      let remainderProposalId: string | null = null;
      if (waiting > 0) {
        try {
          remainderProposalId = await this.carryOver(actor.id, proposalId);
        } catch (err) {
          this.logger.warn(`Could not move the waiting rows of proposal ${proposalId} into a new draft: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { proposalId, status: 'committed', accepted, waiting, remainderProposalId };
    } catch (err) {
      this.logger.warn(`Safe commit of proposal ${proposalId} failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ...base, status: 'failed', reason: errorCode(err) };
    }
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private async isStale(p: { noteId: string | null; noteVersion: number | null }): Promise<boolean> {
    if (p.noteId === null || p.noteVersion === null) return false;
    const note = await this.prisma.note.findUnique({ where: { id: p.noteId }, select: { currentVersion: true } });
    return !note || note.currentVersion > p.noteVersion;
  }

  /** The proposal ids in scope, in order; unusable named ids are appended to `results` as skipped. */
  private async resolveScope(user: GraphActor, dto: CommitBatchDto, results: CommitBatchResult[]): Promise<string[]> {
    if (dto.proposalIds) {
      const unique = [...new Set(dto.proposalIds.map((i) => i.toLowerCase()))];
      const found = await this.prisma.kgProposal.findMany({ where: { id: { in: unique }, ownerId: user.id }, select: { id: true } });
      const known = new Set(found.map((f) => f.id.toLowerCase()));
      for (const id of unique) if (!known.has(id)) results.push({ proposalId: id, status: 'skipped', accepted: 0, waiting: 0, reason: 'not_found' });
      return found.map((f) => f.id);
    }

    let batchIds: string[];
    if (dto.batchId) {
      const batch = await this.prisma.noteImportBatch.findFirst({ where: { id: dto.batchId, ownerId: user.id }, select: { id: true } });
      if (!batch) throw new NotFoundException('No such import batch, or not yours.');
      batchIds = [batch.id];
    } else {
      const library = await this.prisma.noteLibrary.findFirst({ where: { id: dto.libraryId!, ownerId: user.id }, select: { id: true } });
      if (!library) throw new NotFoundException('No such library, or not yours.');
      batchIds = (await this.prisma.noteImportBatch.findMany({ where: { libraryId: library.id, ownerId: user.id }, select: { id: true } })).map((b) => b.id);
    }
    if (batchIds.length === 0) return [];
    const items = await this.prisma.noteImportBatchItem.findMany({
      where: { batchId: { in: batchIds }, noteId: { not: null } },
      select: { noteId: true, noteVersion: true },
    });
    const noteIds = [...new Set(items.flatMap((i) => (i.noteId ? [i.noteId] : [])))];
    if (noteIds.length === 0) return [];
    const drafts = await this.prisma.kgProposal.findMany({
      where: { ownerId: user.id, status: 'draft', kind: 'extraction', noteId: { in: noteIds } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, noteId: true, noteVersion: true },
      take: BATCH_MAX_PROPOSALS,
    });
    return drafts
      .filter((d) => items.some((i) => i.noteId === d.noteId && (i.noteVersion === null || i.noteVersion === d.noteVersion)))
      .map((d) => d.id);
  }

  /**
   * Moves the still-`pending` rows of a just-committed proposal into a new draft of the same
   * note. Returns its id, or `null` when there was nothing to move or the note already has
   * another draft.
   */
  private async carryOver(ownerId: string, proposalId: string): Promise<string | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const proposal = await tx.kgProposal.findUniqueOrThrow({ where: { id: proposalId } });
        if (!proposal.noteId) return null;
        const pending = await tx.kgProposalItem.findMany({ where: { proposalId, decision: 'pending' }, select: { id: true, kind: true, payload: true, editedPayload: true } });
        if (pending.length === 0) return null;
        const other = await tx.kgProposal.findFirst({ where: { noteId: proposal.noteId, status: 'draft' }, select: { id: true } });
        if (other) return null;

        const all = await tx.kgProposalItem.findMany({ where: { proposalId }, select: { kind: true, payload: true, committedRefId: true } });
        const written = new Map<string, string>();
        for (const row of all) {
          const ref = asObject(row.payload).ref;
          if (row.kind === 'entity' && typeof ref === 'string' && row.committedRefId) written.set(ref, row.committedRefId);
        }

        const stats = { ...asObject(proposal.stats) } as Json;
        delete stats.commit;
        stats.prechecked = [];
        stats.carriedOverFrom = proposalId;
        const created = await tx.kgProposal.create({
          data: {
            ownerId,
            kind: proposal.kind,
            status: 'draft',
            noteId: proposal.noteId,
            noteVersion: proposal.noteVersion,
            model: proposal.model,
            provider: proposal.provider,
            systemPrompt: proposal.systemPrompt,
            userContent: proposal.userContent,
            userGuidance: proposal.userGuidance === null ? Prisma.DbNull : (proposal.userGuidance as InputJsonValue),
            stats: stats as InputJsonValue,
          },
          select: { id: true },
        });
        for (const row of pending) {
          await tx.kgProposalItem.update({
            where: { id: row.id },
            data: {
              proposalId: created.id,
              payload: rewriteEndpoints(row.kind, asObject(row.payload), written) as InputJsonValue,
              ...(row.editedPayload ? { editedPayload: rewriteEndpoints(row.kind, asObject(row.editedPayload), written) as InputJsonValue } : {}),
            },
          });
        }
        return created.id;
      },
      { timeout: 30_000 },
    );
  }
}

/** `{ ref }` endpoints naming an entity the commit wrote become `{ entityId }`. */
export function rewriteEndpoints(kind: string, payload: Json, written: ReadonlyMap<string, string>): Json {
  if (kind !== 'relation' && kind !== 'item') return payload;
  const out: Json = { ...payload };
  for (const { field, endpoint } of endpointsOf(kind, payload)) {
    if ('ref' in endpoint && typeof endpoint.ref === 'string') {
      const id = written.get(endpoint.ref);
      if (id) out[field] = { entityId: id };
    }
  }
  return out;
}

function errorCode(err: unknown): string {
  const e = err as { getResponse?: () => unknown; status?: number; message?: string };
  const body = typeof e.getResponse === 'function' ? asObject(e.getResponse()) : {};
  const details = asObject(body.details);
  if (typeof details.reason === 'string') return details.reason;
  if (typeof body.code === 'string') return body.code;
  return e.status ? `http_${e.status}` : 'error';
}

export type { SafePolicyResult };

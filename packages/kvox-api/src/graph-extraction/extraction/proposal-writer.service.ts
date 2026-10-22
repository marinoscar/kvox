// =============================================================================
// ProposalWriter (#363; docs/specs/ontology.md §8, §10)
// =============================================================================
//
// Every write `kg.extract` makes to `kg_proposals`, `kg_proposal_items` and
// `kg_evidence` (subject_kind `proposal_item`). Nothing here touches
// `kg_entities`/`kg_relations`/`kg_items` — a proposal is not the graph (§8).
//
//   - `recordPrompt` — model, provider and the exact prompt, BEFORE the
//     provider call, so a failed run still records what was asked.
//   - `writeItems` — one transaction: any items a previous (deferred) attempt
//     left behind are replaced, then every row and its evidence is inserted,
//     then the proposal's stats. Re-entrant by construction.
//   - `finalize` — one transaction: the pre-check decisions, any older draft
//     for the same note discarded (`discardReason: 'superseded'` — #351's
//     one-draft-per-note index requires the discard FIRST), then this proposal
//     `extracting → draft` with `stats.phase: 'ready'`. A proposal that is no
//     longer `extracting` is left alone.
//   - `markFailed` — `extracting → failed` with `stats.failure`.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { Injectable, Inject } from '@nestjs/common';

import type { ExtractionFailureClass, ExtractionStats } from '../proposals/proposal-payload.schema.js';
import type { ProposedRow } from './validate.js';
import type { KvoxGraphDb, KvoxGraphTx, InputJsonValue } from '../../graph/index.js';
import { Prisma } from '../../core/index.js';
import { KVOX_PRISMA } from '../../ports/index.js';

export interface ItemDecision {
  id: string;
  /** `reject` — #365's rejection memory (`previously_rejected`). */
  decision: 'accept' | 'pending' | 'reject';
}

@Injectable()
export class ProposalWriter {
  constructor(@Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb) {}

  async recordPrompt(
    proposalId: string,
    data: { model: string; provider: string; systemPrompt: string; userContent: string },
  ): Promise<void> {
    await this.prisma.kgProposal.update({ where: { id: proposalId }, data });
  }

  /** Replace this proposal's items with `rows`; returns the ids, in row order. */
  async writeItems(
    proposalId: string,
    ownerId: string,
    rows: ProposedRow[],
    stats: ExtractionStats,
  ): Promise<string[]> {
    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.kgProposalItem.findMany({ where: { proposalId }, select: { id: true } });
      if (previous.length > 0) {
        await tx.kgEvidence.deleteMany({
          where: { subjectKind: 'proposal_item', subjectId: { in: previous.map((p) => p.id) } },
        });
        await tx.kgProposalItem.deleteMany({ where: { proposalId } });
      }
      const ids = await this.insertRows(tx, proposalId, ownerId, rows);
      await tx.kgProposal.update({
        where: { id: proposalId },
        data: { stats: stats as unknown as InputJsonValue },
      });
      return ids;
    });
  }

  /**
   * A NOTE-LESS DRAFT in one transaction (#666): the proposal row (`kind: 'import'`, which
   * `kg_proposals_note_source_chk` allows without a note and which commits through the same path
   * as an extraction), its items and their evidence. Either all of it exists or none, so a crash
   * never leaves an empty draft behind. It is `draft` at once: there is no model call left to
   * wait for. Nothing here touches the graph (§8).
   */
  async createDraft(
    ownerId: string,
    kind: 'import',
    rows: ProposedRow[],
    stats: Record<string, unknown>,
  ): Promise<{ proposalId: string; itemIds: string[] }> {
    return this.prisma.$transaction(async (tx) => {
      const proposal = await tx.kgProposal.create({
        data: { ownerId, kind, status: 'draft', stats: stats as unknown as InputJsonValue },
        select: { id: true },
      });
      const itemIds = await this.insertRows(tx, proposal.id, ownerId, rows);
      return { proposalId: proposal.id, itemIds };
    });
  }

  /** Insert `rows` and their evidence under `proposalId`; returns the item ids in row order. */
  private async insertRows(tx: KvoxGraphTx, proposalId: string, ownerId: string, rows: ProposedRow[]): Promise<string[]> {
    const ids = rows.map(() => randomUUID());
    if (rows.length === 0) return ids;
    await tx.kgProposalItem.createMany({
      data: rows.map((row, i) => ({
        id: ids[i],
        proposalId,
        kind: row.kind,
        payload: row.payload as unknown as InputJsonValue,
        resolution: row.resolution === null ? Prisma.DbNull : (row.resolution as unknown as InputJsonValue),
        flags: [...row.flags],
        decision: 'pending',
        origin: 'ai',
        sortOrder: i,
      })),
    });
    const evidence = rows.flatMap((row, i) =>
      row.evidence.map((e) =>
        e.source === 'segment'
          ? {
              ownerId,
              subjectKind: 'proposal_item' as const,
              subjectId: ids[i],
              transcriptId: e.transcriptId,
              segmentId: e.segmentId,
              segmentRev: e.segmentRev,
              startMs: e.startMs,
              endMs: e.endMs,
              charStart: e.charStart,
              charEnd: e.charEnd,
              quote: e.quote,
            }
          : {
              ownerId,
              subjectKind: 'proposal_item' as const,
              subjectId: ids[i],
              noteId: e.noteId,
              noteVersion: e.noteVersion,
              charStart: e.charStart,
              charEnd: e.charEnd,
              quote: e.quote,
            },
      ),
    );
    if (evidence.length > 0) await tx.kgEvidence.createMany({ data: evidence });
    return ids;
  }

  /**
   * Apply decisions, supersede older drafts, move to `draft`. Returns false
   * when the proposal had already left `extracting` (nothing written).
   */
  async finalize(
    proposalId: string,
    noteId: string,
    decisions: ItemDecision[],
    stats: ExtractionStats,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.kgProposal.findUnique({ where: { id: proposalId }, select: { status: true } });
      if (current?.status !== 'extracting') return false;

      for (const decision of ['accept', 'pending', 'reject'] as const) {
        const ids = decisions.filter((d) => d.decision === decision).map((d) => d.id);
        if (ids.length > 0) {
          await tx.kgProposalItem.updateMany({ where: { proposalId, id: { in: ids } }, data: { decision } });
        }
      }

      await tx.$executeRaw`
        UPDATE "kg_proposals"
           SET "status" = 'discarded',
               "stats" = "stats" || '{"discardReason":"superseded"}'::jsonb,
               "updated_at" = now()
         WHERE "note_id" = ${noteId}::uuid
           AND "status" = 'draft'
           AND "id" <> ${proposalId}::uuid`;

      // `stats.prechecked` (#366): which rows the pre-check ticked, kept apart
      // from `decision` (which the reviewer overwrites) so the review sheet can
      // still say "pre-checked" after the reviewer has changed a row.
      const prechecked = decisions.filter((d) => d.decision === 'accept').map((d) => d.id);
      await tx.kgProposal.update({
        where: { id: proposalId },
        data: { status: 'draft', stats: { ...stats, prechecked } as unknown as InputJsonValue },
      });
      return true;
    });
  }

  /** `extracting → failed`, merging `failure` into the stats. No-op otherwise. */
  async markFailed(
    proposalId: string,
    stats: ExtractionStats,
    failure: { errorClass: ExtractionFailureClass; message: string },
  ): Promise<void> {
    await this.prisma.kgProposal.updateMany({
      where: { id: proposalId, status: 'extracting' },
      data: { status: 'failed', stats: { ...stats, failure } as unknown as InputJsonValue },
    });
  }
}

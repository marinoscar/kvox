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

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { ExtractionFailureClass, ExtractionStats } from '../proposals/proposal-payload.schema';
import type { ProposedRow } from './validate';

export interface ItemDecision {
  id: string;
  decision: 'accept' | 'pending';
}

@Injectable()
export class ProposalWriter {
  constructor(private readonly prisma: PrismaService) {}

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
    const ids = rows.map(() => randomUUID());
    await this.prisma.$transaction(async (tx) => {
      const previous = await tx.kgProposalItem.findMany({ where: { proposalId }, select: { id: true } });
      if (previous.length > 0) {
        await tx.kgEvidence.deleteMany({
          where: { subjectKind: 'proposal_item', subjectId: { in: previous.map((p) => p.id) } },
        });
        await tx.kgProposalItem.deleteMany({ where: { proposalId } });
      }
      if (rows.length > 0) {
        await tx.kgProposalItem.createMany({
          data: rows.map((row, i) => ({
            id: ids[i],
            proposalId,
            kind: row.kind,
            payload: row.payload as unknown as Prisma.InputJsonValue,
            resolution: row.resolution === null ? Prisma.DbNull : (row.resolution as unknown as Prisma.InputJsonValue),
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
      }
      await tx.kgProposal.update({
        where: { id: proposalId },
        data: { stats: stats as unknown as Prisma.InputJsonValue },
      });
    });
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

      for (const decision of ['accept', 'pending'] as const) {
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

      await tx.kgProposal.update({
        where: { id: proposalId },
        data: { status: 'draft', stats: stats as unknown as Prisma.InputJsonValue },
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
      data: { status: 'failed', stats: { ...stats, failure } as unknown as Prisma.InputJsonValue },
    });
  }
}

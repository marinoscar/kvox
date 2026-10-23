// =============================================================================
// kg.autocommit (#718, epic #708; ADR-0007)
// =============================================================================
//
// Commits the SAFE rows of one freshly drafted extraction proposal when its note's library
// opted into auto-commit. No new write path: the work is `ProposalBatchCommitService.commitSafe`
// (the safe policy, then `ProposalCommitService` and `GraphWriteService`). Rows the policy does
// not accept (a sensitive PersonFact, a closing, an ambiguous or merge row, a row under the
// owner's `review.minConfidence`) stay in a draft for a person.
//
//   profile     { maxRuntimeMs: 5 min, maxAttempts: 2 }
//   server-only no nodeResultSchema, no persistNodeResult
//   subject     `kg_proposal` / proposalId
//   payload     { proposalId, ownerId }
//   trigger     `kvox.graph.proposal_drafted` (a subscriber that only enqueues)
//
// It NO-OPS (returns normally, nothing is retried) when: the proposal is not an `extraction`
// draft of the owner, the note moved on (stale), the note has no library or the library's
// `auto_commit` is off, the graph is disabled, or the owner no longer holds `graph:write`.
//
// Audit: one `graph:autocommit` row with ids and counts. ⚠ Never a statement or evidence text.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { GRAPH_WRITE_PERMISSION, GraphAiRunResolver, KG_AUTOCOMMIT_JOB_TYPE } from '../../graph/index.js';
import type { GraphActor, KvoxGraphDb } from '../../graph/index.js';
import { NoteLibraryPolicy } from '../../notes/index.js';
import {
  KVOX_AUDIT,
  KVOX_IDENTITY,
  KVOX_JOBS,
  KVOX_PRISMA,
  type KvoxAuditPort,
  type KvoxIdentityPort,
  type KvoxJob,
  type KvoxJobHandler,
  type KvoxJobProfile,
  type KvoxJobsPort,
} from '../../ports/index.js';
import { ProposalBatchCommitService } from '../proposals/proposal-batch-commit.service.js';

/**
 * The audit action of one auto-commit (permanent).
 *
 * @stability experimental
 */
export const GRAPH_AUTOCOMMIT_ACTION = 'graph:autocommit';

const payloadSchema = z.object({ proposalId: z.guid(), ownerId: z.guid() });
export type KgAutocommitPayload = z.infer<typeof payloadSchema>;

/** Reads the payload; null when unreadable (the job is a no-op, never a failure loop). */
export function readKgAutocommitPayload(payload: unknown): KgAutocommitPayload | null {
  const parsed = payloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/**
 * KgAutocommitHandler: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class KgAutocommitHandler implements KvoxJobHandler, OnModuleInit {
  private readonly logger = new Logger(KgAutocommitHandler.name);

  readonly type = KG_AUTOCOMMIT_JOB_TYPE;
  readonly label = 'Auto-commit safe graph rows';
  readonly profile: KvoxJobProfile = { maxRuntimeMs: 5 * 60_000, maxAttempts: 2 };

  constructor(
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    @Inject(KVOX_IDENTITY) private readonly identity: KvoxIdentityPort,
    @Inject(KVOX_AUDIT) private readonly audit: KvoxAuditPort,
    private readonly resolver: GraphAiRunResolver,
    private readonly libraries: NoteLibraryPolicy,
    private readonly batch: ProposalBatchCommitService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: KvoxJob): Promise<void> {
    const payload = readKgAutocommitPayload(job.payload);
    if (!payload) {
      this.logger.warn(`${KG_AUTOCOMMIT_JOB_TYPE} job ${job.id} carries an unreadable payload; nothing to do`);
      return;
    }
    const { proposalId, ownerId } = payload;

    const proposal = await this.prisma.kgProposal.findFirst({
      where: { id: proposalId, ownerId },
      select: { id: true, status: true, kind: true, noteId: true, noteVersion: true },
    });
    if (!proposal || proposal.status !== 'draft' || proposal.kind !== 'extraction' || !proposal.noteId) {
      this.logger.log(`${KG_AUTOCOMMIT_JOB_TYPE} proposal ${proposalId} is not an open extraction draft; no-op`);
      return;
    }

    const policy = await this.libraries.forNote(proposal.noteId);
    if (!policy?.autoCommit) return;

    if (!(await this.resolver.graphEnabled())) return;
    if (!(await this.identity.hasPermission(ownerId, GRAPH_WRITE_PERMISSION))) return;

    const note = await this.prisma.note.findUnique({ where: { id: proposal.noteId }, select: { currentVersion: true } });
    if (!note || (proposal.noteVersion !== null && note.currentVersion > proposal.noteVersion)) {
      this.logger.log(`${KG_AUTOCOMMIT_JOB_TYPE} proposal ${proposalId} is stale; no-op`);
      return;
    }

    const actor: GraphActor = { id: ownerId, permissions: [GRAPH_WRITE_PERMISSION] };
    const result = await this.batch.commitSafe(actor, proposalId, {});

    try {
      await this.audit.record({
        actorUserId: ownerId,
        action: GRAPH_AUTOCOMMIT_ACTION,
        targetType: 'kg_proposal',
        targetId: proposalId,
        meta: {
          noteId: proposal.noteId,
          libraryId: policy.libraryId,
          status: result.status,
          ...(result.reason ? { reason: result.reason } : {}),
          accepted: result.accepted,
          waiting: result.waiting,
        },
      });
    } catch (error) {
      this.logger.warn(`Audit of an auto-commit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.logger.log(`${KG_AUTOCOMMIT_JOB_TYPE} proposal=${proposalId} status=${result.status} accepted=${result.accepted} waiting=${result.waiting}`);
  }
}

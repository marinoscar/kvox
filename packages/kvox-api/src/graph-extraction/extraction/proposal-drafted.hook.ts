import { Inject, Injectable, Logger } from '@nestjs/common';

import { GRAPH_PROPOSAL_DRAFTED_EVENT } from '../../graph/index.js';
import type { GraphProposalDraftedEvent, KvoxGraphDb } from '../../graph/index.js';
import { KVOX_EVENTS, KVOX_PRISMA, type KvoxEventsPort } from '../../ports/index.js';

// =============================================================================
// What follows an extraction becoming a draft (#716, #718; ADR-0007)
// =============================================================================
//
// Called by `kg.extract` AFTER `ProposalWriter.finalize` committed (never inside a graph write
// transaction). Best effort: a failure is logged and swallowed, the draft already exists.
//
//   1. stamp `note_library_files.extracted_version` (one `updateMany`, never lowering it), so the
//      reconcile job can tell a note the graph has read from one it has not;
//   2. emit `kvox.graph.proposal_drafted`, whose only listener enqueues `kg.autocommit`.
//
// ⚠ Logs carry ids only.
// =============================================================================

/**
 * ProposalDraftedHook: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class ProposalDraftedHook {
  private readonly logger = new Logger(ProposalDraftedHook.name);

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    @Inject(KVOX_EVENTS) private readonly events: KvoxEventsPort,
  ) {}

  /** Records that the graph has read `noteVersion` of the note and announces the draft. Never throws. */
  async afterDraft(args: Omit<GraphProposalDraftedEvent, 'kind'>): Promise<void> {
    try {
      await this.prisma.noteLibraryFile.updateMany({
        where: {
          noteId: args.noteId,
          OR: [{ extractedVersion: null }, { extractedVersion: { lt: args.noteVersion } }],
        },
        data: { extractedVersion: args.noteVersion },
      });
    } catch (error) {
      this.logger.warn(
        `Could not stamp extracted_version of note ${args.noteId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      this.events.emit(GRAPH_PROPOSAL_DRAFTED_EVENT, { ...args, kind: 'extraction' } satisfies GraphProposalDraftedEvent);
    } catch (error) {
      this.logger.warn(
        `Could not announce the draft ${args.proposalId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// =============================================================================
// AliasLearningService (#364; docs/specs/ontology.md §7)
// =============================================================================
//
// An accepted link teaches resolution: the mention's label becomes an alias of
// the linked entity (provenance `extraction` — a confirmed resolution, not the
// model's own guess), so the next exact-alias arm finds it without scoring.
// Takes the caller's transaction: #366's commit calls it inside its own.
// =============================================================================

import { Injectable, NotFoundException } from '@nestjs/common';
import type { KgAliasSource, Prisma } from '@prisma/client';

import { GRAPH_NOT_FOUND_MESSAGES } from '../access/graph-access.service';
import { GraphValidationError } from '../write/graph-write.errors';
import { GraphWriteService } from '../write/graph-write.service';

type Tx = Prisma.TransactionClient;

@Injectable()
export class AliasLearningService {
  constructor(private readonly write: GraphWriteService) {}

  /**
   * An accepted link: `label` becomes an alias of `entityId` unless it already
   * is (normalized). Returns the new alias id, or null when nothing was added.
   */
  async recordLink(tx: Tx, entityId: string, label: string, source: KgAliasSource = 'extraction'): Promise<string | null> {
    const entity = await tx.kgEntity.findUnique({ where: { id: entityId }, select: { ownerId: true } });
    if (!entity) throw new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.entity);
    try {
      const added = await this.write.addAliases(tx, entity.ownerId, entityId, [{ alias: label, source }]);
      return added[0]?.id ?? null;
    } catch (error) {
      // A label with no letters or digits is not learnable, and not a commit failure.
      if (error instanceof GraphValidationError) return null;
      throw error;
    }
  }
}

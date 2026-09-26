// =============================================================================
// ResolutionActionsService (#364; docs/specs/ontology.md §7, §12, §19)
// =============================================================================
//
// The envelope around the three human resolution actions — authorise every id
// through `GraphAccessService` (404 never 403; a tombstone is a 404), then hand
// the write to `MergeService` / `DistinctPairService`, then audit.
//
//   merge     `:id` INTO `intoId`. A manual merge of two curated entities is
//             allowed — it IS the human decision §7 requires.
//   reverse   the merge row is authorised as kind `merge`; an already reversed
//             merge is the same 404 a missing one is.
//   distinct  "these two are not the same", recorded canonically, idempotent.
// =============================================================================

import { BadRequestException, Injectable } from '@nestjs/common';

import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { GraphAccessService } from '../access/graph-access.service';
import { KG_SUBJECT_ENTITY } from '../job-types';
import { DistinctPairService } from './distinct-pair.service';
import type { DistinctPairResponse, MergeEntityResponse, ReverseMergeResponse } from './dto/resolution.dto';
import { MergeService } from './merge.service';

export const GRAPH_DISTINCT_PAIR_RECORDED_ACTION = 'graph.distinct_pair_recorded';

@Injectable()
export class ResolutionActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GraphAccessService,
    private readonly merges: MergeService,
    private readonly distinct: DistinctPairService,
  ) {}

  async merge(id: string, intoId: string, user: RequestUser): Promise<MergeEntityResponse> {
    if (id.toLowerCase() === intoId.toLowerCase()) {
      throw new BadRequestException('An entity cannot be merged into itself.');
    }
    await this.access.require(user.id, 'entity', id, 'edit', user.permissions);
    await this.access.require(user.id, 'entity', intoId, 'edit', user.permissions);
    return this.merges.merge({ ownerId: user.id, mergedId: id, survivorId: intoId, actorId: user.id, source: 'manual' });
  }

  async reverse(mergeId: string, user: RequestUser): Promise<ReverseMergeResponse> {
    await this.access.require(user.id, 'merge', mergeId, 'edit', user.permissions);
    return this.merges.reverse({ ownerId: user.id, mergeId, actorId: user.id });
  }

  async recordDistinct(aId: string, bId: string, user: RequestUser): Promise<DistinctPairResponse> {
    if (aId.toLowerCase() === bId.toLowerCase()) {
      throw new BadRequestException('An entity is always the same as itself.');
    }
    await this.access.require(user.id, 'entity', aId, 'edit', user.permissions);
    await this.access.require(user.id, 'entity', bId, 'edit', user.permissions);
    const result = await this.prisma.$transaction((tx) => this.distinct.record(tx, user.id, aId, bId));
    if (result.created) {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: user.id,
          action: GRAPH_DISTINCT_PAIR_RECORDED_ACTION,
          targetType: KG_SUBJECT_ENTITY,
          targetId: result.aId,
          meta: { aId: result.aId, bId: result.bId, source: 'manual' },
        },
      });
    }
    return result;
  }
}

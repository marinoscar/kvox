// =============================================================================
// ContextFeatureService (#364, epic #346; docs/specs/ontology.md §7)
// =============================================================================
//
// The context half of `score.ts`'s features, for a set of candidates at once —
// a bounded number of queries per mention batch, never one per candidate:
//
//   sameMeeting     the candidate is IDENTIFIED_AS a speaker of this transcript,
//                   or ATTENDED one of the context meetings
//   orgCoMention    the candidate WORKS_FOR / HAS_ROLE an organization that is
//                   also in the context (by id, or by a normalized name/alias of
//                   an organization the proposal mentions but has not linked)
//   sharedNeighbour ≥ 1 common 1-hop neighbour with the context's co-mentioned
//                   entities (organizations and meetings excluded — they already
//                   carry their own, stronger signal above)
//   recent          evidence on the candidate in the last 90 days
//
// Owner-scoped everywhere, live rows (`accepted`/`edited`) only.
// =============================================================================

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

export const RECENCY_WINDOW_DAYS = 90;
const LIVE = ['accepted', 'edited'] as const;
const ORG_RELATIONS = ['WORKS_FOR', 'HAS_ROLE'];

export interface ResolutionContext {
  speakerPersonIds: ReadonlySet<string>;
  meetingIds: ReadonlySet<string>;
  orgIds: ReadonlySet<string>;
  /** `normalizeAlias` forms of organizations named but not linked. */
  orgNames: ReadonlySet<string>;
  neighbourIds: ReadonlySet<string>;
}

export interface ContextFeatures {
  sameMeeting: boolean;
  orgCoMention: boolean;
  sharedNeighbour: boolean;
  recent: boolean;
}

export function emptyContext(): ResolutionContext {
  return { speakerPersonIds: new Set(), meetingIds: new Set(), orgIds: new Set(), orgNames: new Set(), neighbourIds: new Set() };
}

type Db = PrismaService | Prisma.TransactionClient;

@Injectable()
export class ContextFeatureService {
  constructor(private readonly prisma: PrismaService) {}

  async features(
    ownerId: string,
    candidateIds: readonly string[],
    ctx: ResolutionContext,
    now: Date = new Date(),
    db: Db = this.prisma,
  ): Promise<Map<string, ContextFeatures>> {
    const ids = [...new Set(candidateIds)];
    const out = new Map<string, ContextFeatures>(
      ids.map((id) => [id, { sameMeeting: ctx.speakerPersonIds.has(id), orgCoMention: false, sharedNeighbour: false, recent: false }]),
    );
    if (ids.length === 0) return out;

    const relations = await db.kgRelation.findMany({
      where: {
        ownerId,
        reviewStatus: { in: [...LIVE] },
        OR: [{ fromId: { in: ids } }, { toId: { in: ids } }],
      },
      select: { type: true, fromId: true, toId: true },
    });

    const orgTargets = new Map<string, Set<string>>(); // candidate → org ids
    for (const r of relations) {
      const fromCandidate = r.fromId !== null && out.has(r.fromId);
      if (fromCandidate && r.type === 'ATTENDED' && ctx.meetingIds.has(r.toId)) out.get(r.fromId!)!.sameMeeting = true;
      if (fromCandidate && ORG_RELATIONS.includes(r.type)) {
        const set = orgTargets.get(r.fromId!) ?? new Set<string>();
        set.add(r.toId);
        orgTargets.set(r.fromId!, set);
      }
      // Shared neighbours: the other end of any live edge, minus orgs/meetings.
      const pairs: Array<[string | null, string | null]> = [
        [r.fromId, r.toId],
        [r.toId, r.fromId],
      ];
      for (const [self, other] of pairs) {
        if (!self || !other || !out.has(self)) continue;
        if (ctx.neighbourIds.has(other) && !ctx.orgIds.has(other) && !ctx.meetingIds.has(other)) {
          out.get(self)!.sharedNeighbour = true;
        }
      }
    }

    // Organization co-mention: by id, else by any normalized name of the org.
    const allOrgIds = [...new Set([...orgTargets.values()].flatMap((s) => [...s]))];
    if (allOrgIds.length > 0) {
      const names = ctx.orgNames.size > 0
        ? await db.kgEntityAlias.findMany({ where: { ownerId, entityId: { in: allOrgIds } }, select: { entityId: true, normalized: true } })
        : [];
      const namedOrgs = new Set(names.filter((n) => ctx.orgNames.has(n.normalized)).map((n) => n.entityId));
      for (const [candidate, orgs] of orgTargets) {
        if ([...orgs].some((o) => ctx.orgIds.has(o) || namedOrgs.has(o))) out.get(candidate)!.orgCoMention = true;
      }
    }

    const since = new Date(now.getTime() - RECENCY_WINDOW_DAYS * 86_400_000);
    const recent = await db.kgEvidence.findMany({
      where: { ownerId, subjectKind: 'entity', subjectId: { in: ids }, createdAt: { gte: since } },
      select: { subjectId: true },
      distinct: ['subjectId'],
    });
    for (const r of recent) out.get(r.subjectId)!.recent = true;

    return out;
  }
}

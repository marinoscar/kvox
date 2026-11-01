// =============================================================================
// GraphSelfService (#778; docs/specs/ontology.md §6.1 "Self identity")
// =============================================================================
//
// Who the account owner is in their own graph. The CHOICE is the per-user preference
// `graph.self.entityId`; this service turns the stored id into a usable Person:
//
//   - the id must be a Person of THIS user (another user's id, a deleted row or another
//     type resolves to null: no error, the preference is simply inert);
//   - a merged-away Person is followed through `mergedIntoId` to the survivor (a merge
//     never silently un-sets who the user is);
//   - the survivor must be live (`accepted` / `edited`, not merged).
//
// It also SUGGESTS: while nothing is chosen, the Persons whose label or alias equals the
// user's profile name, normalized as resolution normalizes. A suggestion is read-only;
// nothing here writes the preference or the graph.
//
// ⚠ Never logs a name.
// =============================================================================

import { Inject, Injectable } from '@nestjs/common';

import { KVOX_PRISMA } from '../../ports/index.js';
import type { KvoxGraphDb } from '../data/graph-db.js';
import { GraphPreferencesService } from '../preferences/graph-preferences.service.js';
import { selfName, SELF_MERGE_HOPS, type ResolvedSelf } from './graph-self.js';

/** Most suggestions offered. */
export const SELF_SUGGESTION_LIMIT = 5;

const LIVE = ['accepted', 'edited'];

interface PersonRow {
  id: string;
  type: string;
  label: string;
  reviewStatus: string;
  mergedIntoId: string | null;
  aliases?: Array<{ alias: string }>;
}

function toSelf(row: PersonRow): ResolvedSelf {
  return {
    entityId: row.id,
    label: row.label,
    aliases: [...new Set((row.aliases ?? []).map((a) => a.alias).filter((a) => a !== row.label))],
  };
}

/**
 * GraphSelfService: wiring the slice registers itself; a host configures it through `GraphModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class GraphSelfService {
  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    private readonly preferences: GraphPreferencesService,
  ) {}

  /** The chosen Person, resolved; null when none is chosen or it is no longer a live Person of this user. */
  async resolve(userId: string): Promise<ResolvedSelf | null> {
    const { self } = await this.preferences.get(userId);
    if (!self.entityId) return null;
    return this.resolveEntity(userId, self.entityId);
  }

  /** The resolved id only (a read response marks this node). */
  async entityId(userId: string): Promise<string | null> {
    return (await this.resolve(userId))?.entityId ?? null;
  }

  /** `id` as a live Person of `userId`, following merges; null when it is none. */
  async resolveEntity(userId: string, id: string): Promise<ResolvedSelf | null> {
    let current = id;
    const seen = new Set<string>();
    for (let hop = 0; hop <= SELF_MERGE_HOPS; hop += 1) {
      if (seen.has(current)) return null;
      seen.add(current);
      const row = (await this.prisma.kgEntity.findFirst({
        where: { id: current, ownerId: userId },
        select: {
          id: true,
          type: true,
          label: true,
          reviewStatus: true,
          mergedIntoId: true,
          aliases: { select: { alias: true }, orderBy: { createdAt: 'asc' } },
        },
      })) as PersonRow | null;
      if (!row || row.type !== 'Person') return null;
      if (row.mergedIntoId) {
        current = row.mergedIntoId;
        continue;
      }
      return LIVE.includes(row.reviewStatus) ? toSelf(row) : null;
    }
    return null;
  }

  /** The profile name of the user, or null when the host has none. */
  async displayName(userId: string): Promise<string | null> {
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ display_name: string | null; provider_display_name: string | null }>
      >`SELECT display_name, provider_display_name FROM users WHERE id = ${userId}::uuid`;
      const name = (rows[0]?.display_name || rows[0]?.provider_display_name || '').trim();
      return name.length > 0 ? name : null;
    } catch {
      return null;
    }
  }

  /** Live Persons whose label or alias equals the profile name. Empty when there is no name. */
  async suggest(userId: string, displayName?: string | null): Promise<ResolvedSelf[]> {
    const name = displayName === undefined ? await this.displayName(userId) : displayName;
    const normalized = name ? selfName(name) : null;
    if (normalized === null) return [];
    const ids = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT e.id::text AS id
        FROM kg_entities e
        JOIN kg_entity_aliases a ON a.entity_id = e.id
       WHERE e.owner_id = ${userId}::uuid
         AND e.type = 'Person'
         AND e.review_status IN ('accepted', 'edited')
         AND e.merged_into_id IS NULL
         AND a.normalized = ${normalized}
       LIMIT ${SELF_SUGGESTION_LIMIT}`;
    if (ids.length === 0) return [];
    const rows = (await this.prisma.kgEntity.findMany({
      where: { ownerId: userId, id: { in: ids.map((r) => r.id) } },
      select: {
        id: true,
        type: true,
        label: true,
        reviewStatus: true,
        mergedIntoId: true,
        aliases: { select: { alias: true }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { updatedAt: 'desc' },
    })) as PersonRow[];
    return rows.map(toSelf);
  }

  /** The `GET /graph/self` answer: the chosen Person, else suggestions. */
  async describe(userId: string): Promise<{ self: ResolvedSelf | null; suggestions: ResolvedSelf[]; displayName: string | null }> {
    const [self, displayName] = [await this.resolve(userId), await this.displayName(userId)];
    return { self, suggestions: self ? [] : await this.suggest(userId, displayName), displayName };
  }
}

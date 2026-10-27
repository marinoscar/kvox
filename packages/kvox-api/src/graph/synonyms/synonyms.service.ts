// =============================================================================
// SynonymsService (issue #767)
// =============================================================================
//
// The caller's personal synonym dictionary: groups of names that mean the same
// thing ("OAC" = "Org Alpha Consulting"), consulted by entity resolution, the
// possible-duplicates pass and the entity search.
//
// ⚠ THIS IS A USER DICTIONARY, NOT A GRAPH WRITE. A synonym group is not a
// `kg_entities`, `kg_relations` or `kg_items` row and carries no evidence, so it
// does not go through `GraphWriteService` (which owns only graph rows). It never
// creates, merges or edits an entity: it only widens what a name matches.
//
// Owner-only: another user's group is a 404, never a 403. `normalized` is
// `normalizeAlias` of each term, de-duplicated; fewer than two distinct
// normalized terms is a 400 `synonyms_too_few`; an entity type outside the
// caller's effective ontology is a 400; the 501st group is a 409
// `synonyms_limit`.
// =============================================================================

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  SYNONYM_MAX_GROUPS,
  SYNONYM_MIN_TERMS,
  type CreateSynonymGroupDto,
  type ListSynonymGroupsResponse,
  type SynonymGroup,
  type UpdateSynonymGroupDto,
} from '@marinoscar/kvox-contract/graph';

import { KVOX_PRISMA } from '../../ports/index.js';
import type { KgSynonymRow, KvoxGraphDb } from '../data/graph-db.js';
import type { GraphActor } from '../graph-actor.js';
import { GraphOntologyService } from '../ontology/graph-ontology.service.js';
import { GraphValidationError } from '../write/graph-write.errors.js';
import { normalizeSynonymTerms } from './synonym-terms.js';

export const SYNONYM_NOT_FOUND_MESSAGE = 'Synonym group not found';

/** Maps a row to its wire shape. */
export function toSynonymGroup(row: KgSynonymRow): SynonymGroup {
  return {
    id: row.id,
    terms: row.terms,
    entityType: row.entityType,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SynonymsService: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class SynonymsService {
  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    private readonly ontology: GraphOntologyService,
  ) {}

  async list(user: GraphActor): Promise<ListSynonymGroupsResponse> {
    const rows = await this.prisma.kgSynonym.findMany({
      where: { ownerId: user.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: SYNONYM_MAX_GROUPS,
    });
    return { groups: rows.map(toSynonymGroup) };
  }

  async create(dto: CreateSynonymGroupDto, user: GraphActor): Promise<SynonymGroup> {
    const parsed = this.parse(dto.terms);
    const entityType = await this.checkType(user.id, dto.entityType ?? null);
    const count = await this.prisma.kgSynonym.count({ where: { ownerId: user.id } });
    if (count >= SYNONYM_MAX_GROUPS) {
      throw new ConflictException({
        message: `You already have ${SYNONYM_MAX_GROUPS} synonym groups. Delete one first.`,
        details: { reason: 'synonyms_limit', limit: SYNONYM_MAX_GROUPS },
      });
    }
    const row = await this.prisma.kgSynonym.create({
      data: { ownerId: user.id, terms: parsed.terms, normalized: parsed.normalized, entityType },
    });
    return toSynonymGroup(row);
  }

  async update(id: string, dto: UpdateSynonymGroupDto, user: GraphActor): Promise<SynonymGroup> {
    await this.require(id, user.id);
    const parsed = this.parse(dto.terms);
    const entityType = await this.checkType(user.id, dto.entityType ?? null);
    const row = await this.prisma.kgSynonym.update({
      where: { id },
      data: { terms: parsed.terms, normalized: parsed.normalized, entityType },
    });
    return toSynonymGroup(row);
  }

  async remove(id: string, user: GraphActor): Promise<void> {
    await this.require(id, user.id);
    await this.prisma.kgSynonym.delete({ where: { id } });
  }

  private async require(id: string, ownerId: string): Promise<KgSynonymRow> {
    const row = UUID.test(id) ? await this.prisma.kgSynonym.findUnique({ where: { id } }) : null;
    if (!row || row.ownerId !== ownerId) throw new NotFoundException(SYNONYM_NOT_FOUND_MESSAGE);
    return row;
  }

  private parse(terms: readonly string[]) {
    let parsed;
    try {
      parsed = normalizeSynonymTerms(terms);
    } catch (err) {
      if (err instanceof GraphValidationError) {
        throw new BadRequestException({ message: 'Every term needs at least one letter or digit.', details: { reason: 'synonyms_invalid_term' } });
      }
      throw err;
    }
    if (parsed.normalized.length < SYNONYM_MIN_TERMS) {
      throw new BadRequestException({
        message: `A synonym group needs at least ${SYNONYM_MIN_TERMS} different names (case, spacing and edge punctuation do not count).`,
        details: { reason: 'synonyms_too_few' },
      });
    }
    return parsed;
  }

  private async checkType(userId: string, entityType: string | null): Promise<string | null> {
    if (entityType === null) return null;
    const schema = await this.ontology.effectiveSchemaFor(userId);
    const type = schema.entityType(entityType);
    if (!type || type.deprecated) {
      throw new BadRequestException({
        message: `'${entityType}' is not an entity type in your graph.`,
        details: { reason: 'unknown_entity_type' },
      });
    }
    return entityType;
  }
}

// =============================================================================
// GraphAccessService (#354, epic #344, docs/specs/ontology.md §12)
// =============================================================================
//
// ONE FUNCTION, SEVEN KINDS, AND A 404 FOR EVERYTHING ELSE.
//
//   require(userId, kind, id, 'view' | 'edit', permissions?, options?)
//
// The only code path that authorises a graph row. Every graph controller calls
// it before touching a row — there is no second owner check anywhere, and one
// service with a `kind` discriminator (rather than seven per-table services)
// keeps the not-found rule in exactly one place, so no copy can drift into a
// 403.
//
// -----------------------------------------------------------------------------
// ⚠ NO ACCESS IS A 404. NEVER A 403.
// -----------------------------------------------------------------------------
//
// Carried across from `NoteAccessService` and `TranscriptAccessService`: a 403
// would confirm that graph row `abc123` exists and merely refuse the caller. A
// graph is derived from somebody's private conversations and notes, and the
// existence of a specific id is itself something a stranger has no business
// learning. So a MISSING row, ANOTHER OWNER'S row, and — for entities,
// relations and items — a row that is not part of the caller's reviewed graph
// (`review_status` `unreviewed` or `rejected`) all answer the SAME status with
// the SAME byte-identical message per kind (`GRAPH_NOT_FOUND_MESSAGES`). Two
// differently-worded 404s would reintroduce exactly the oracle the status code
// was chosen to remove.
//
// A `merged` row is also a 404, unless the caller passes
// `options.includeMerged` — the entity page (#364/#370) uses that to redirect
// to `merged_into_id` instead of showing a dead end.
//
// -----------------------------------------------------------------------------
// NO SHARING PATH EXISTS, AND NONE IS LOOKED UP
// -----------------------------------------------------------------------------
//
// A transcript share NEVER grants graph access (§12): the graph is the owner's
// own curated reading of what they saw, not the conversation itself. There is
// deliberately no `graph:read_any` permission either, for any role. So the
// only question asked here is "is this the caller's row".
//
// -----------------------------------------------------------------------------
// THE SERVICE RETURNS THE ROW
// -----------------------------------------------------------------------------
//
// Exactly as `NoteAccessService`: a caller that looked the row up itself and
// only then asked for permission is the shape that quietly undoes all of the
// above. `require` returns the row, so nothing above it needs to query a
// `kg_*` table on its own to authorise.
//
// -----------------------------------------------------------------------------
// `edit` ALSO REQUIRES `graph:write`, AND THAT ONE IS A 403
// -----------------------------------------------------------------------------
//
// Same reasoning as `NoteAccessService.assertWritePermission`: a caller who can
// genuinely see the row already knows it exists, so a 404 would only lie to
// them about their own data. The permission check therefore runs AFTER the
// ownership check — a stranger without `graph:write` still gets the 404.
// =============================================================================

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  KgAttributeDef,
  KgEntity,
  KgEvidence,
  KgItem,
  KgMerge,
  KgProposal,
  KgRelation,
  KgReviewStatus,
} from '@prisma/client';

import { PERMISSIONS } from '../../common/constants/roles.constants';
import { PrismaService } from '../../prisma/prisma.service';

/** Every kind of graph row this service authorises. */
export type GraphSubjectKind =
  | 'entity'
  | 'relation'
  | 'item'
  | 'proposal'
  | 'attribute_def'
  | 'evidence'
  | 'merge';

/** What a caller is asking to do. */
export type GraphAccessLevel = 'view' | 'edit';

/** Options for `require`. */
export interface GraphAccessOptions {
  /**
   * Admit a `merged` entity (relation, item) instead of answering 404, so the
   * caller can redirect to `merged_into_id`. Nothing else is relaxed.
   */
  includeMerged?: boolean;
}

/**
 * The message every no-access answer uses, verbatim, per kind.
 *
 * ONE STRING PER KIND, so "not found", "not yours" and "not in your reviewed
 * graph" are byte-identical. See the header.
 */
export const GRAPH_NOT_FOUND_MESSAGES: Record<GraphSubjectKind, string> = {
  entity: 'Entity not found',
  relation: 'Relation not found',
  item: 'Item not found',
  proposal: 'Proposal not found',
  attribute_def: 'Attribute definition not found',
  evidence: 'Evidence not found',
  merge: 'Merge not found',
};

/** The row type `require` returns, per kind. */
export interface GraphRowByKind {
  entity: KgEntity;
  relation: KgRelation;
  item: KgItem;
  proposal: KgProposal;
  attribute_def: KgAttributeDef;
  evidence: KgEvidence;
  merge: KgMerge;
}

/** Review states that are not part of the caller's graph at all. */
const HIDDEN_REVIEW_STATUSES: ReadonlySet<KgReviewStatus> = new Set<KgReviewStatus>([
  'unreviewed',
  'rejected',
]);

/** The kinds that carry a `review_status`. */
const REVIEWED_KINDS: ReadonlySet<GraphSubjectKind> = new Set<GraphSubjectKind>([
  'entity',
  'relation',
  'item',
]);

/**
 * UUID-shaped, any version. Every `kg_*` id is a `@db.Uuid`; a malformed id
 * handed to Prisma would be a 500 rather than a 404, so it is refused here
 * with the same 404 a missing row gets. Controllers use `ParseUUIDPipe` too —
 * this is the backstop for non-HTTP callers.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class GraphAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Authorise, and return the row.
   *
   * `permissions` is the caller's effective permission list, as the JWT
   * carries it. It is only consulted for `edit`; passing it for a `view` check
   * costs nothing and keeps every call site uniform.
   */
  require(
    userId: string,
    kind: 'entity',
    id: string,
    level: GraphAccessLevel,
    permissions?: readonly string[],
    options?: GraphAccessOptions,
  ): Promise<KgEntity>;
  require(
    userId: string,
    kind: 'relation',
    id: string,
    level: GraphAccessLevel,
    permissions?: readonly string[],
    options?: GraphAccessOptions,
  ): Promise<KgRelation>;
  require(
    userId: string,
    kind: 'item',
    id: string,
    level: GraphAccessLevel,
    permissions?: readonly string[],
    options?: GraphAccessOptions,
  ): Promise<KgItem>;
  require(
    userId: string,
    kind: 'proposal',
    id: string,
    level: GraphAccessLevel,
    permissions?: readonly string[],
    options?: GraphAccessOptions,
  ): Promise<KgProposal>;
  require(
    userId: string,
    kind: 'attribute_def',
    id: string,
    level: GraphAccessLevel,
    permissions?: readonly string[],
    options?: GraphAccessOptions,
  ): Promise<KgAttributeDef>;
  require(
    userId: string,
    kind: 'evidence',
    id: string,
    level: GraphAccessLevel,
    permissions?: readonly string[],
    options?: GraphAccessOptions,
  ): Promise<KgEvidence>;
  require(
    userId: string,
    kind: 'merge',
    id: string,
    level: GraphAccessLevel,
    permissions?: readonly string[],
    options?: GraphAccessOptions,
  ): Promise<KgMerge>;
  async require(
    userId: string,
    kind: GraphSubjectKind,
    id: string,
    level: GraphAccessLevel,
    permissions: readonly string[] = [],
    options: GraphAccessOptions = {},
  ): Promise<GraphRowByKind[GraphSubjectKind]> {
    const notFound = () => new NotFoundException(GRAPH_NOT_FOUND_MESSAGES[kind]);

    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw notFound();

    const row = await this.find(kind, id);

    // ⚠ THE SAME 404 for missing and for another owner's row, for every level.
    // There is no sharing lookup to fall back to — see the header.
    if (!row || row.ownerId !== userId) throw notFound();

    if (REVIEWED_KINDS.has(kind)) {
      const status = (row as { reviewStatus: KgReviewStatus }).reviewStatus;
      if (HIDDEN_REVIEW_STATUSES.has(status)) throw notFound();
      if (status === 'merged' && options.includeMerged !== true) throw notFound();
    }

    this.assertWritePermission(level, permissions);

    return row;
  }

  /**
   * Whether EVERY id names a row the caller owns — one query, for batch
   * validation (a proposal commit, a bulk edit).
   *
   * Ownership only: it does not apply `require`'s review-status visibility,
   * because a batch validator decides what it will accept per row itself. An
   * empty list is trivially true. A malformed id is false, never a Prisma
   * error. Duplicates are counted once.
   */
  async ownsAll(
    userId: string,
    kind: 'entity' | 'item' | 'relation',
    ids: readonly string[],
  ): Promise<boolean> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return true;
    if (unique.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id))) return false;

    const where = { id: { in: unique }, ownerId: userId };
    let count: number;
    switch (kind) {
      case 'entity':
        count = await this.prisma.kgEntity.count({ where });
        break;
      case 'relation':
        count = await this.prisma.kgRelation.count({ where });
        break;
      case 'item':
        count = await this.prisma.kgItem.count({ where });
        break;
    }
    return count === unique.length;
  }

  private find(
    kind: GraphSubjectKind,
    id: string,
  ): Promise<GraphRowByKind[GraphSubjectKind] | null> {
    const where = { where: { id } };
    switch (kind) {
      case 'entity':
        return this.prisma.kgEntity.findUnique(where);
      case 'relation':
        return this.prisma.kgRelation.findUnique(where);
      case 'item':
        return this.prisma.kgItem.findUnique(where);
      case 'proposal':
        return this.prisma.kgProposal.findUnique(where);
      case 'attribute_def':
        return this.prisma.kgAttributeDef.findUnique(where);
      case 'evidence':
        return this.prisma.kgEvidence.findUnique(where);
      case 'merge':
        return this.prisma.kgMerge.findUnique(where);
    }
  }

  /**
   * `edit` mutates, and needs `graph:write`.
   *
   * 403 rather than 404 — the caller can already see the row. See the header.
   */
  private assertWritePermission(
    level: GraphAccessLevel,
    permissions: readonly string[],
  ): void {
    if (level === 'view') return;

    if (!permissions.includes(PERMISSIONS.GRAPH_WRITE)) {
      throw new ForbiddenException(
        `This action requires the ${PERMISSIONS.GRAPH_WRITE} permission.`,
      );
    }
  }
}

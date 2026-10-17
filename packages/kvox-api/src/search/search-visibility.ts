import { Inject, Injectable } from '@nestjs/common';

import { Prisma } from '../core/index.js';
import { KVOX_PRISMA, type KvoxPrismaClientLike, type KvoxSql } from '../ports/index.js';

// =============================================================================
// Which transcripts a user may see: the host's decision (issue #494, epic #491)
// =============================================================================
//
// Search reads `transcripts` and `transcript_segments` with raw SQL and has to
// restrict every candidate query to the transcripts the caller may read. What
// "may read" means is the HOST's rule, not the slice's:
//
//   • KVox Desktop has one local user, who owns everything: a transcript is
//     visible when it is live and the caller owns it. That is this file's default,
//     {@link OwnerOnlyTranscriptVisibility}.
//   • The web edition also shows a transcript SHARED with the caller, and a share
//     is a platform grant under row-level security: the condition is built by the
//     platform and the statement has to run in the caller's organization scope. It
//     provides its own implementation through `SearchModuleOptions.transcriptVisibility`.
//
// THE CONTRACT THE SLICE HOLDS EVERY IMPLEMENTATION TO
// -----------------------------------------------------------------------------
//
//   1. `transcriptVisibleSql` returns a condition on the table aliased `alias`
//      (one of the closed literals {@link SearchTranscriptAlias}). It MUST exclude
//      soft-deleted rows. It is spliced INSIDE the candidate query's `LIMIT`, in
//      every arm: filtering after the top-K gives a user who owns 1% of the
//      corpus an empty answer to a query with thousands of matches, with no
//      error anywhere (`search.service.ts` carries the whole argument).
//   2. Every statement that carries that condition runs through `run`, because
//      the web edition's shared-transcript condition consults a table that is
//      invisible outside the viewer's organization scope.
//   3. Notes are NOT shareable and have no extension point: a note is visible to
//      its owner and to nobody else.
// =============================================================================

/**
 * The table aliases a transcript condition is ever built for. A closed union of
 * literals, because the alias is spliced into SQL text.
 *
 * @stability experimental
 */
export type SearchTranscriptAlias = 'tt' | 'st' | 't';

/**
 * The caller, resolved to whatever scope the host decides visibility in. The
 * slice reads only `userId`; an implementation may extend it.
 *
 * @stability experimental
 */
export interface SearchViewer {
  /** The caller. */
  readonly userId: string;
}

/**
 * The client a scoped statement runs on: raw queries only.
 *
 * @stability experimental
 */
export type SearchScopedClient = Pick<KvoxPrismaClientLike, '$queryRaw'>;

/**
 * The host's rule for which transcripts a caller may see.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface SearchTranscriptVisibility {
  /**
   * Resolves the caller to the scope visibility is decided in.
   *
   * @param userId - the authenticated caller.
   */
  viewerFor(userId: string): Promise<SearchViewer>;

  /**
   * The `WHERE` condition for a transcript the viewer may see, on the table
   * aliased `alias`: live, and owned by the viewer or visible to them some other
   * way the host defines.
   *
   * @param viewer - from {@link viewerFor}.
   * @param alias - the transcript table's alias in the statement.
   */
  transcriptVisibleSql(viewer: SearchViewer, alias: SearchTranscriptAlias): KvoxSql;

  /**
   * Runs `fn` in the viewer's scope (for the web edition, one transaction scoped
   * to the viewer's organization and user). Use `tx.$queryRaw` inside.
   *
   * @param viewer - from {@link viewerFor}.
   * @param fn - the statements to run.
   */
  run<R>(viewer: SearchViewer, fn: (tx: SearchScopedClient) => Promise<R>): Promise<R>;
}

/**
 * Injection token of the {@link SearchTranscriptVisibility} the module binds.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const SEARCH_TRANSCRIPT_VISIBILITY = Symbol.for('@marinoscar/kvox/SEARCH_TRANSCRIPT_VISIBILITY');

/**
 * The default rule: a transcript is visible to its owner while it is not
 * soft-deleted. Needs no scope, so `run` hands the host client straight to the
 * callback.
 *
 * @stability experimental
 */
@Injectable()
export class OwnerOnlyTranscriptVisibility implements SearchTranscriptVisibility {
  constructor(@Inject(KVOX_PRISMA) private readonly db: KvoxPrismaClientLike) {}

  async viewerFor(userId: string): Promise<SearchViewer> {
    return { userId };
  }

  transcriptVisibleSql(viewer: SearchViewer, alias: SearchTranscriptAlias): KvoxSql {
    const a = Prisma.raw(alias);

    return Prisma.sql`(${a}.deleted_at IS NULL AND ${a}.owner_id = ${viewer.userId}::uuid)`;
  }

  run<R>(_viewer: SearchViewer, fn: (tx: SearchScopedClient) => Promise<R>): Promise<R> {
    return fn(this.db);
  }
}

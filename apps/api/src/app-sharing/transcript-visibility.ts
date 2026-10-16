// =============================================================================
// Which transcripts a user may see, for the code that reads them with raw SQL
// (issue #485, epic #478)
// =============================================================================
//
// A transcript is shared through a platform `grants` row, and `grants` is an
// organization table under FORCED row-level security: a statement that does not
// run in an organization's scope sees NO grant. Search, Ask citations and the
// graph's document reads join `transcripts` with raw SQL, so they cannot ask the
// platform "is this shared with me" through a plain `$queryRaw`. They do it the
// sanctioned way instead:
//
//   1. `transcriptViewer(prisma, userId)`      the caller and the organization
//   2. `transcriptVisibleSql(viewer, 't')`     the condition for `WHERE`, built by
//                                              the platform's `accessibleSql`
//   3. `inViewerScope(prisma, viewer, fn)`     the statement, run in the viewer's
//                                              organization scope (`runInOrg`)
//
// The condition is the old `owner_id = me OR EXISTS (transcript_shares ...)`:
// not soft-deleted, and either owned by the caller or shared with them through an
// active, unexpired grant of any role. NOTHING in this app reads `grants`
// directly (the `no-direct-access` check of the sharing conformance suite).
//
// This file is BASE code (no import of a domain folder), so `search/`, `ask/` and
// `graph/` can use it without depending on `transcripts/`.
// =============================================================================

import { Prisma } from '@prisma/client';
import type { Principal } from '@marinoscar/platform-api/core';
import { resolveOrgId } from '@marinoscar/platform-api/identity';
import type { DefaultOrgReader } from '@marinoscar/platform-api/identity';
import { accessibleSql, accessibleWhere } from '@marinoscar/platform-api/sharing';

import { TRANSCRIPT_RESOURCE_TYPE } from '../app-registrations/sharing';

/**
 * What the helpers need of the database: the default-organization read and
 * `runInOrg`. `PrismaService` is one; a unit test passes a fake.
 */
export interface ViewerDb extends DefaultOrgReader {
  runInOrg<R>(
    scope: { orgId: string; userId?: string },
    fn: (tx: ViewerTx) => Promise<R>,
  ): Promise<R>;
}

/** The transaction client the statements run on: raw queries only. */
export type ViewerTx = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** A caller, resolved to the organization their transcripts are decided in. */
export interface TranscriptViewer {
  readonly userId: string;
  readonly orgId: string;
  readonly principal: Principal;
}

/**
 * The principal `AccessPolicy` and `accessibleSql` decide for.
 *
 * The organization is passed in: this app runs ONE organization
 * (single-organization mode) and every transcript carries the default one.
 * `groups` is empty on purpose, since group grants are not grantable for the
 * `transcript` type, which also spares the groups lookup.
 */
export function principalOf(userId: string, orgId: string, permissions: readonly string[]): Principal {
  return {
    kind: 'user',
    userId,
    email: '',
    credential: 'session',
    roles: [],
    permissions,
    activeOrgId: orgId,
    groups: [],
  };
}

/**
 * Resolves the viewer: the caller in the default organization (one small
 * indexed read, not cached: a test database may be rebuilt under a long-lived
 * client).
 */
export async function transcriptViewer(prisma: DefaultOrgReader, userId: string): Promise<TranscriptViewer> {
  const orgId = await resolveOrgId(prisma, null, `transcript visibility for ${userId}`);

  return { userId, orgId, principal: principalOf(userId, orgId, []) };
}

/**
 * The `WHERE` condition for a transcript the viewer may see, on the table aliased
 * `alias`: live, and owned by the viewer or shared with them. Run the statement
 * through {@link inViewerScope}, or the grants it consults are invisible.
 */
export function transcriptVisibleSql(viewer: TranscriptViewer, alias: string): Prisma.Sql {
  // `accessibleSql` validates `alias` as a plain identifier (it throws otherwise),
  // so the raw fragment below can only ever be one.
  const condition = accessibleSql(viewer.principal, TRANSCRIPT_RESOURCE_TYPE, alias, {
    sqlKit: Prisma,
    scope: 'all',
    ownerUserColumn: 'owner_id',
  });

  return Prisma.sql`(${Prisma.raw(alias)}.deleted_at IS NULL AND ${condition})`;
}

/**
 * Runs `fn` in ONE transaction scoped to the viewer's organization and user
 * (`set_config(..., true)`, transaction-local), so row-level security shows the
 * viewer's organization's grants. Use `tx.$queryRaw` inside.
 */
export function inViewerScope<R>(
  prisma: Pick<ViewerDb, 'runInOrg'>,
  viewer: TranscriptViewer,
  fn: (tx: ViewerTx) => Promise<R>,
): Promise<R> {
  return prisma.runInOrg({ orgId: viewer.orgId, userId: viewer.userId }, fn);
}

/**
 * The `where` fragment for the transcripts shared WITH this user (an active,
 * unexpired grant of any role): the platform's `accessibleWhere`, scope `shared`.
 * One bounded grant query inside the caller's organization scope; above
 * `SHARED_IDS_INLINE_LIMIT` (1,000) shared transcripts it switches to the EXISTS
 * form, whose ids are read with one raw statement. AND it with the ids you asked
 * about, and OR it with `{ ownerId: userId }` for "owned or shared" (the old
 * `shares: { some: { userId } }` relation filter).
 */
export async function sharedTranscriptsWhere(
  prisma: ViewerDb & DefaultOrgReader,
  userId: string,
): Promise<Prisma.TranscriptWhereInput> {
  const viewer = await transcriptViewer(prisma, userId);

  return prisma.runInOrg({ orgId: viewer.orgId, userId }, async (tx) => {
    const access = await accessibleWhere(viewer.principal, TRANSCRIPT_RESOURCE_TYPE, {
      tx,
      sqlKit: Prisma,
      scope: 'shared',
      ownerUserField: 'ownerId',
      sql: { alias: 'r', ownerUserColumn: 'owner_id' },
    });

    if (access.form === 'where') return access.where as Prisma.TranscriptWhereInput;

    const rows = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT r.id::text AS id FROM transcripts r WHERE r.deleted_at IS NULL AND ${access.sql}`,
    );

    return { id: { in: rows.map((row) => row.id) } };
  });
}

// =============================================================================
// Test helper: create a transcripts row the way the schema wants it (issue #485)
// =============================================================================
//
// For the real-Postgres (`*.db.spec.ts`) suites that need a transcript as a
// fixture. `transcripts.org_id` is NOT NULL (the organization the platform
// sharing slice decides a transcript's access in), so a fixture that names none
// gets the default organization, as `TranscriptsService.create` does in
// single-organization mode.
// =============================================================================

import { defaultOrgId } from './storage-object.helper';

/** `prisma.transcript.create(args)` with `orgId` defaulted to the default organization. */
export async function createTranscript(
  client: unknown,
  args: { data: Record<string, any>; [key: string]: any },
): Promise<any> {
  const orgId = args.data.orgId ?? (await defaultOrgId(client));

  return (client as { transcript: { create: (args: any) => Promise<any> } }).transcript.create({
    ...args,
    data: { ...args.data, orgId },
  });
}

/**
 * Shares a transcript the way the platform stores it (issue #485): one ACTIVE
 * `grants` row of resource type `transcript`, a user grantee and a role. Replaces
 * `prisma.transcriptShare.create`. Returns the grant row.
 */
export async function shareTranscript(
  client: unknown,
  share: { transcriptId: string; userId: string; role: 'viewer' | 'editor'; grantedById: string; orgId?: string },
): Promise<any> {
  const orgId = share.orgId ?? (await defaultOrgId(client));

  return (client as { grant: { create: (args: any) => Promise<any> } }).grant.create({
    data: {
      orgId,
      resourceType: 'transcript',
      resourceId: share.transcriptId,
      granteeKind: 'user',
      granteeUserId: share.userId,
      role: share.role,
      grantedById: share.grantedById,
    },
  });
}

/** Deletes every transcript grant on the transcripts matching `where` (the cleanup `transcript_shares` got from its cascade). */
export async function deleteTranscriptGrants(client: unknown, where: Record<string, unknown>): Promise<void> {
  const db = client as {
    transcript: { findMany: (args: any) => Promise<Array<{ id: string }>> };
    grant: { deleteMany: (args: any) => Promise<unknown> };
  };
  const ids = (await db.transcript.findMany({ where, select: { id: true } })).map((row) => row.id);

  await db.grant.deleteMany({ where: { resourceType: 'transcript', resourceId: { in: ids } } });
}

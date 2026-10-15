// =============================================================================
// Running a handler's `storage_objects` access inside the job's organization
// =============================================================================
//
// `JobScope.run` (`@marinoscar/platform-api/jobs`) opens one transaction with
// `app.org_id` set to `job.orgId`, and REFUSES a job whose `orgId` is null: a
// system job keeps the bypass connection. The jobs whose handlers touch
// `storage_objects` are enqueued with an organization (#468), but a row queued
// by a build before the platform queue has none. For those the organization is
// the one the job's payload names, else the default organization in single-
// tenancy mode (`resolveJobOrgId`), so a pending pre-upgrade job still runs
// after the deploy instead of failing on the missing scope.
//
// Keep `fn` short: it holds a database transaction. Streaming to or from the
// object store happens outside it.
// =============================================================================

import type { Prisma } from '@prisma/client';
import { resolveJobOrgId } from '@marinoscar/platform-api/identity';
import type { Job, JobScope } from '@marinoscar/platform-api/jobs';

import type { PrismaService } from '../prisma/prisma.service';

/** Runs `fn` in one transaction scoped to the job's organization. */
export async function runInJobOrg<R>(
  scope: JobScope,
  prisma: PrismaService,
  job: Pick<Job, 'id' | 'type' | 'payload' | 'orgId'>,
  fn: (tx: Prisma.TransactionClient) => Promise<R>,
): Promise<R> {
  const orgId = job.orgId ?? (await resolveJobOrgId(prisma, job));

  return scope.run<R, Prisma.TransactionClient>({ id: job.id, orgId }, fn);
}

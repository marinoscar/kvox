// =============================================================================
// What the control plane sends BACK to a node (issues #268 & #269, epic #254)
// =============================================================================
//
// THE DESIGN CONSTRAINT OF THIS WHOLE ISSUE IS VISIBLE IN THIS FILE: a node
// has no database access and no storage credentials, so every fact it needs
// has to arrive in an HTTP response. These classes are that surface, and the
// mapper functions below are the only place a Prisma row is turned into one.
//
// MAPPED EXPLICITLY, FIELD BY FIELD, rather than returning the row. Two
// reasons, and the first is the one that matters:
//
//   1. A `WorkerNode` or `Job` row that is returned wholesale gains whatever
//      column the next migration adds — to a remote machine, silently, with
//      no review of whether that column should have left the building. The
//      explicit map makes "publish this to the fleet" an edit somebody makes
//      on purpose. `Job.lastError` is the live example: it can carry a
//      provider's raw response, and the node has no use for the previous
//      attempt's error.
//   2. Dates become ISO 8601 strings here rather than being handed to the
//      global interceptor as `Date` objects, matching `NodeCredentialController`
//      — which is what makes `lastHeartbeatAt: null` visibly a real value in
//      the response rather than a field that happens to be missing.
//
// -----------------------------------------------------------------------------
// `params` IS A SEPARATE BAG FROM `job`, AND IT IS NOT DECORATION
// -----------------------------------------------------------------------------
//
// A claim returns `{ job, params }` pairs rather than one flattened object.
// `job` is a faithful (narrowed) projection of the row — the node echoes its
// `id` and `type` back on every subsequent call. `params` is EVERYTHING THE
// NODE NEEDS TO ACTUALLY RUN THE WORK that is not a column of the row: today
// that is the job's `payload`, and a fork's own server-derived values go here
// rather than beside the projection.
//
// ⚠ #269's PRESIGNED URLS DID NOT LAND HERE, and the reason is worth
// recording because this comment used to predict that they would. Minting a
// signed URL at claim time spends its lifetime on the wrong clock: a node
// claiming its whole `concurrency` in one call queues that work internally,
// so the last job's URL has been ageing since before the first job started —
// and the obvious fix, a longer expiry, widens exactly the window a short
// expiry exists to close. They are minted on demand instead, by
// `POST /nodes/:id/jobs/:jobId/download-url` and `…/upload-url`. See
// `node-data-plane.service.ts` and docs/specs/worker-nodes.md §18.
//
// Keeping the two bags apart still matters, and now for the general case: a
// reader can always tell "this came out of the row" from "this server minted
// this for you". Flattened into one object, a server-derived value would be
// indistinguishable from a column, and the first person to add a column named
// like a param would produce a very confusing bug.
// =============================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Job, WorkerNode } from '@prisma/client';

/** One worker node, as the fleet sees it. */
export class WorkerNodeDto {
  @ApiProperty({ description: 'Node ID (UUID)' })
  id!: string;

  @ApiProperty({
    description:
      'Operator-chosen name. Unique per owner, and the identity half of ' +
      'register-or-reattach: registering this name again reattaches to this row.',
  })
  name!: string;

  @ApiProperty({ description: 'Self-reported host name' })
  hostname!: string;

  @ApiProperty({ description: 'Self-reported platform (e.g. `linux-x64`)' })
  platform!: string;

  @ApiProperty({ description: 'Self-reported CLI version' })
  cliVersion!: string;

  @ApiProperty({
    description:
      'The job types this node declared it can run. A claim can only ever narrow this list.',
    type: [String],
  })
  eligibleTypes!: string[];

  @ApiProperty({
    description:
      'The node’s declared concurrency ceiling. Read live on every claim, so a ' +
      'heartbeat that changes it takes effect on the very next claim.',
  })
  concurrency!: number;

  @ApiProperty({
    description:
      'Operator/administrative state — NOT liveness. `disabled` refuses this node’s ' +
      'claims; `draining` lets it finish what it holds and claim nothing new. Liveness ' +
      'is `lastHeartbeatAt` compared against the heartbeat interval.',
    enum: ['online', 'draining', 'offline', 'disabled'],
  })
  status!: string;

  @ApiPropertyOptional({
    description: 'The node’s last self-reported capability summary, or `null` if it has reported none.',
    nullable: true,
    type: Object,
  })
  capabilities!: unknown;

  @ApiProperty({ description: 'ISO 8601 timestamp of first registration' })
  registeredAt!: string;

  @ApiPropertyOptional({
    description: 'ISO 8601 timestamp of the last heartbeat, or `null` if it has never sent one.',
    nullable: true,
  })
  lastHeartbeatAt!: string | null;
}

/** The response to `POST /nodes/register`. */
export class RegisterNodeResponseDto {
  @ApiProperty({ description: 'The registered (or reattached) node', type: WorkerNodeDto })
  node!: WorkerNodeDto;

  @ApiProperty({
    description:
      '`true` when an existing row for this `(owner, name)` was refreshed rather than a new ' +
      'one created — the normal outcome for a restarted worker. Reported in the body rather ' +
      'than as a different status code so a client never has to branch on 200-vs-201 to learn ' +
      'something it can read here.',
  })
  reattached!: boolean;
}

/** A claimed job, as the node sees it. */
export class NodeJobDto {
  @ApiProperty({ description: 'Job ID (UUID) — echo this back on renew/result/failure' })
  id!: string;

  @ApiProperty({ description: 'Job type — echo this back on result, where it is verified' })
  type!: string;

  @ApiPropertyOptional({ description: 'Subject type this job is about', nullable: true })
  subjectType!: string | null;

  @ApiPropertyOptional({ description: 'Subject ID this job is about', nullable: true })
  subjectId!: string | null;

  @ApiProperty({ description: 'Scheduling priority (lower runs first)' })
  priority!: number;

  @ApiProperty({
    description:
      'Attempts STARTED, including this one — it is charged at claim time, so it is never 0 here.',
  })
  attempts!: number;

  @ApiProperty({ description: 'ISO 8601 timestamp this attempt started' })
  startedAt!: string | null;

  @ApiProperty({
    description:
      'ISO 8601 lease expiry. Renew before this passes, or the job is requeued and any ' +
      'result posted afterwards is refused with 409.',
  })
  leaseExpiresAt!: string | null;
}

/** One claimed job plus the inputs needed to run it. */
export class NodeJobAssignmentDto {
  @ApiProperty({ description: 'The claimed job row, narrowed', type: NodeJobDto })
  job!: NodeJobDto;

  @ApiProperty({
    description:
      'Everything the node needs to run this job that is not a column of the row — the job’s ' +
      '`payload`. Deliberately separate from `job` so a server-minted value is never mistaken ' +
      'for a column. Presigned data-plane URLs are NOT here: they are minted on demand by ' +
      '`POST /nodes/{id}/jobs/{jobId}/download-url` and `…/upload-url`, so their short expiry ' +
      'starts when the transfer does rather than when the batch was claimed.',
    type: Object,
  })
  params!: Record<string, unknown>;

  @ApiProperty({
    description:
      'How often, in milliseconds, this node should renew the job’s lease — derived by the ' +
      'SERVER from the same lease it just granted (a third of it, clamped), so a node never ' +
      'has to guess. Prefer it over any local default: a job whose type declares a six-hour ' +
      'runtime ceiling takes a six-hour lease, and renewing that every 30 seconds is 720 ' +
      'round trips to say something the server already knew. Optional for a node to honour — ' +
      'an older client that ignores this field renews on its own cadence and stays correct, ' +
      'just chattier.',
  })
  renewIntervalMs!: number;
}

/** The response to `POST /nodes/:id/claim`. */
export class ClaimJobsResponseDto {
  @ApiProperty({
    description:
      'The rows this call took, in no particular order — `UPDATE … RETURNING` promises none. ' +
      'An empty array is the common, non-error answer.',
    type: [NodeJobAssignmentDto],
  })
  jobs!: NodeJobAssignmentDto[];
}

/** The response to `POST /nodes/:id/jobs/:jobId/renew`. */
export class RenewLeaseResponseDto {
  @ApiProperty({ description: 'The job whose lease was extended' })
  jobId!: string;

  @ApiProperty({ description: 'ISO 8601 timestamp of the new lease expiry' })
  leaseExpiresAt!: string;
}

/** The response to a result or failure submission. */
export class JobSettlementResponseDto {
  @ApiProperty({ description: 'The job that was settled' })
  jobId!: string;

  @ApiProperty({
    description:
      'What the terminal state machine decided: `succeeded`, `failed`, `retry-scheduled`, ' +
      '`rate-limit-deferred`, or `write-failed` (the row was left for the lease reaper).',
    enum: ['succeeded', 'failed', 'retry-scheduled', 'rate-limit-deferred', 'write-failed'],
  })
  outcome!: string;

  @ApiProperty({
    description:
      'Whether this job WILL run again — the server’s answer, not the node’s. A node may send ' +
      '`willRetry` on a failure; the attempt budget decides, and this field reports the decision.',
  })
  willRetry!: boolean;
}

// =============================================================================
// Mappers — the ONLY place a row becomes a response
// =============================================================================

/** A `WorkerNode` row as the wire shape above. */
export function toWorkerNodeDto(node: WorkerNode): WorkerNodeDto {
  return {
    id: node.id,
    name: node.name,
    hostname: node.hostname,
    platform: node.platform,
    cliVersion: node.cliVersion,
    eligibleTypes: node.eligibleTypes,
    concurrency: node.concurrency,
    status: node.status,
    capabilities: node.capabilities ?? null,
    registeredAt: node.registeredAt.toISOString(),
    lastHeartbeatAt: node.lastHeartbeatAt ? node.lastHeartbeatAt.toISOString() : null,
  };
}

/**
 * A claimed `Job` row as `{ job, params }`.
 *
 * ⚠ THE NARROWING IS THE SECURITY-RELEVANT PART. `payload` is forwarded (it
 * IS the job's input, and a node with no database access has no other way to
 * get it) while `lastError`, `dedupKey`, `reason`, `providerKey` and the
 * rate-limit counters are not: none of them is an input to the work, and each
 * is a fact about this deployment's internals that a remote machine has no
 * reason to hold.
 */
export function toNodeJobAssignment(job: Job, renewIntervalMs: number): NodeJobAssignmentDto {
  return {
    job: {
      id: job.id,
      type: job.type,
      subjectType: job.subjectType,
      subjectId: job.subjectId,
      priority: job.priority,
      attempts: job.attempts,
      startedAt: job.startedAt ? job.startedAt.toISOString() : null,
      leaseExpiresAt: job.leaseExpiresAt ? job.leaseExpiresAt.toISOString() : null,
    },
    // `payload` is JSONB and may legitimately be `null` (a job with no
    // inputs) or a non-object (nothing in this repository writes one, but the
    // column permits it). Both collapse to `{}` so a node can always read
    // `params.foo` without first checking what it received — a null-shaped
    // crash on a worker somebody else operates is a bad way to learn that a
    // job type takes no arguments.
    params:
      job.payload !== null && typeof job.payload === 'object' && !Array.isArray(job.payload)
        ? (job.payload as Record<string, unknown>)
        : {},
    // A PARAMETER, NOT SOMETHING THIS MAPPER DERIVES. The interval comes from
    // the type's lease, which comes from its execution profile, which lives in
    // the handler registry — none of which a pure row-to-wire mapper has, or
    // should acquire. The caller already resolved the lease to make the claim;
    // it passes the interval it derived from that same lease, so the node is
    // told a cadence that matches the lease it was actually granted.
    renewIntervalMs,
  };
}

// =============================================================================
// /api/nodes — the routes a worker node talks to (issues #268 & #269, epic #254)
// =============================================================================
//
// Twelve routes, two services, and a controller that binds, documents and
// authorizes — nothing else. Every decision about what a request MEANS lives
// in `nodes.service.ts` (the control plane) and `node-data-plane.service.ts`
// (#269's presigned IO), including both guards; this file must not grow a
// second opinion about ownership or about a lease, because a check written
// here would be a check the services' own callers (and their tests) do not
// get. The data plane's two routes go through the SAME
// `assertJobHeldByNode` the control plane's do — reused, never reimplemented.
//
// -----------------------------------------------------------------------------
// THIS IS THE MOUNT POINT THE `nod_` ALLOWLIST HAS BEEN POINTING AT SINCE #267
// -----------------------------------------------------------------------------
//
// `JwtAuthGuard` admits a `nod_` credential on exactly `/api/nodes` and paths
// beneath it, and refuses it everywhere else — including `/api/node-credentials`,
// so a worker token can never mint another. Until this controller existed,
// that allowlist pointed at nothing: a request to `/api/nodes` 404'd in the
// router before the guard ran, which is why #267 could only assert the
// admitted side by invoking the guard directly. These routes are what make
// the boundary testable over real HTTP, and
// `test/nodes/node-credential.integration.spec.ts` now does exactly that.
//
// ⚠ CONSEQUENCE WORTH KNOWING BEFORE ADDING A ROUTE HERE: everything mounted
// under this controller is reachable by a node credential. That is the
// intended blast radius (`docs/specs/worker-nodes.md` §1), and it means a
// route added here is a route an unattended, months-old credential on
// somebody else's box can call. Anything that is not part of the node
// conversation belongs on a different prefix.
//
// -----------------------------------------------------------------------------
// PERMISSIONS, AND WHY THE READS ARE SPLIT FROM THE WRITES
// -----------------------------------------------------------------------------
//
// Every write route is `nodes:write`; `GET /nodes`, `GET /nodes/:id` and
// `GET /nodes/job-types` are `nodes:read`. Note that MINTING A SIGNED URL is a
// write (`download-url` included): it hands out a capability against storage
// and is scoped by a lease the node must be actively holding, which is not
// the shape of anything a read-only auditor should be able to do.
// The split is the same one `/api/node-credentials` makes and
// exists for the same reason: a role that may AUDIT the fleet without being
// able to change it is a distinction worth being able to express, and it is
// the entire reason the permission pair is split at all. Note that claiming a
// job is a WRITE — it takes rows and marks them running — even though a node
// operator might think of "get me work" as a read.
//
// -----------------------------------------------------------------------------
// ⚠ THE LITERALS ARE DECLARED BEFORE THE `:id` ROUTES, AND THE ORDER IS LOAD-BEARING
// -----------------------------------------------------------------------------
//
// Nest matches in DECLARATION ORDER, not by specificity. `POST /nodes/register`
// is one segment, exactly like a `POST /nodes/:id` would be, so the day
// somebody adds one — an "update this node" route is the obvious candidate —
// a `register` declared after it becomes unreachable, and the symptom is a
// fleet-wide "node not found: register" with a UUID validation error rather
// than anything naming this file. Literals first removes the trap in advance.
//
// `GET /nodes/job-types` (#269) is the live case, not a hypothetical one:
// `GET /nodes/:id` ALREADY EXISTS, so declaring `job-types` after it would
// route every request for the contract list into the node lookup, where
// `ParseUUIDPipe` would answer `400 "Validation failed (uuid is expected)"`
// for a path that has nothing to do with a UUID. It is declared immediately
// after `register`, above every parameterised route.
//
// -----------------------------------------------------------------------------
// WHY `register` RETURNS 200 AND NOT 201
// -----------------------------------------------------------------------------
//
// It creates a row roughly half the time and refreshes an existing one the
// rest — a restarted container reattaches, which is the normal case in a
// steady fleet. Returning 201 for one and 200 for the other would make every
// client branch on a status code to learn something the body already says
// (`reattached`), and would publish "a node was created" as the meaning of a
// status code on an endpoint whose whole design goal is that restarting a
// container creates nothing. One status, one shape, one field to read.
// =============================================================================

import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Auth } from '../auth/decorators/auth.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/roles.constants';
import {
  ClaimJobsDto,
  HeartbeatNodeDto,
  NodeJobFailureDto,
  NodeJobResultDto,
  RegisterNodeDto,
} from './dto/node-control-plane.dto';
import {
  ClaimJobsResponseDto,
  JobSettlementResponseDto,
  RegisterNodeResponseDto,
  RenewLeaseResponseDto,
  toNodeJobAssignment,
  toWorkerNodeDto,
  WorkerNodeDto,
} from './dto/node-response.dto';
import {
  NodeDownloadUrlResponseDto,
  NodeJobTypesResponseDto,
  NodeUploadUrlDto,
  NodeUploadUrlResponseDto,
} from './dto/node-data-plane.dto';
import {
  NodeJobSecretRequestDto,
  NodeJobSecretResponseDto,
} from './dto/node-job-secret.dto';
import { NodeDataPlaneService } from './node-data-plane.service';
import { NodeSecretBrokerService } from './node-secret-broker.service';
import { NodesService } from './nodes.service';

@ApiTags('Worker Nodes')
@Controller('nodes')
export class NodesController {
  constructor(
    private readonly nodes: NodesService,
    private readonly dataPlane: NodeDataPlaneService,
    private readonly secrets: NodeSecretBrokerService
  ) {}

  // ---------------------------------------------------------------------------
  // Literal routes first — see the header.
  // ---------------------------------------------------------------------------

  @Post('register')
  @Auth({ permissions: [PERMISSIONS.NODES_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Register a worker node, or reattach to an existing one',
    description:
      'Idempotent on `(owner, name)`: registering a name this owner already used REATTACHES ' +
      'to that node — refreshing its hostname, platform, CLI version, eligible types and ' +
      'concurrency, and bringing it back online — rather than creating a second row. That is ' +
      'what lets a container be recreated without leaking a node on every restart. `reattached` ' +
      'in the response says which happened. If the existing row is still heartbeating the server ' +
      'warns and proceeds (last writer wins); if an operator has DISABLED the node, that status ' +
      'survives the re-registration and the node still may not claim.',
  })
  @ApiResponse({ status: 200, description: 'Registered or reattached', type: RegisterNodeResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async register(
    @Body() dto: RegisterNodeDto,
    @CurrentUser('id') userId: string
  ): Promise<RegisterNodeResponseDto> {
    const { node, reattached } = await this.nodes.register(userId, dto);

    return { node: toWorkerNodeDto(node), reattached };
  }

  @Get('job-types')
  @Auth({ permissions: [PERMISSIONS.NODES_READ] })
  @ApiOperation({
    summary: 'List the job types a node can run, with their result contracts',
    description:
      'Every type whose handler carries both `nodeResultSchema` and `persistNodeResult` — the ' +
      'only types a claim can ever return — each with a JSON Schema (2020-12) for the `result` ' +
      'a submission must carry. The schema is generated from the server’s own Zod definition, ' +
      'so a client validates against what this server will actually enforce rather than ' +
      'against a copy that can go stale. `resultSchema` is `null` for the rare type whose ' +
      'schema has no JSON Schema representation; submit and let the server validate. ' +
      'The list is derived from the handler registry, so a fork’s own types appear with no ' +
      'list to edit.',
  })
  @ApiResponse({ status: 200, description: 'The node-eligible types', type: NodeJobTypesResponseDto })
  async listJobTypes(): Promise<NodeJobTypesResponseDto> {
    // ASYNC SINCE #349: the list is intersected with this deployment's
    // `nodes.jobSecretBrokerEnabled` setting, so a type that needs a per-job
    // credential does not appear where the deployment does not issue them.
    return { types: await this.nodes.listNodeEligibleJobTypes() };
  }

  @Get()
  @Auth({ permissions: [PERMISSIONS.NODES_READ] })
  @ApiOperation({
    summary: "List the caller's worker nodes",
    description:
      'Fleet inventory for the calling owner: what is registered, what each node says it can ' +
      'run, and when each was last heard from. `status` is operator state, not liveness — a node ' +
      'can read `online` and be silently dead; compare `lastHeartbeatAt` to answer that.',
  })
  @ApiResponse({ status: 200, description: 'The nodes this user registered', type: [WorkerNodeDto] })
  async list(@CurrentUser('id') userId: string): Promise<WorkerNodeDto[]> {
    const nodes = await this.nodes.listNodes(userId);

    return nodes.map(toWorkerNodeDto);
  }

  @Get(':id')
  @Auth({ permissions: [PERMISSIONS.NODES_READ] })
  @ApiOperation({
    summary: 'Get one worker node',
    description:
      'Returns the node when it belongs to the caller. A node that does not exist is `404`; ' +
      'one that belongs to somebody else is `403` — deliberately distinguishable, because a ' +
      'node id is not a secret and an operator holding the wrong id needs to be told the truth ' +
      'rather than sent off to re-register.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The node', type: WorkerNodeDto })
  @ApiResponse({ status: 404, description: 'No such node' })
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string
  ): Promise<WorkerNodeDto> {
    return toWorkerNodeDto(await this.nodes.getNode(userId, id));
  }

  // ---------------------------------------------------------------------------
  // The node's own lifecycle
  // ---------------------------------------------------------------------------

  @Post(':id/deregister')
  @Auth({ permissions: [PERMISSIONS.NODES_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deregister a worker node (graceful shutdown)',
    description:
      'Marks the node `offline`. It deliberately does NOT requeue the jobs the node is ' +
      'holding: nothing proves a shutting-down process has actually stopped working, and ' +
      'requeueing on the node’s say-so would hand a still-running job to a second executor. ' +
      'Held jobs return through the lease reaper once their leases expire — the same path a ' +
      'crashed node takes.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The node, now offline', type: WorkerNodeDto })
  async deregister(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') userId: string
  ): Promise<WorkerNodeDto> {
    return toWorkerNodeDto(await this.nodes.deregister(userId, id));
  }

  @Post(':id/heartbeat')
  @Auth({ permissions: [PERMISSIONS.NODES_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Report liveness, and optionally refresh capabilities or concurrency',
    description:
      'Stamps `lastHeartbeatAt` and applies whatever the node reports about itself. A new ' +
      '`concurrency` takes effect on the very NEXT claim — the claim endpoint reads the row ' +
      'live rather than caching a value from registration. A node may report only `online` or ' +
      '`offline`: `draining` and `disabled` are operator decisions, and a heartbeat can never ' +
      'clear either of them.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The refreshed node', type: WorkerNodeDto })
  async heartbeat(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HeartbeatNodeDto,
    @CurrentUser('id') userId: string
  ): Promise<WorkerNodeDto> {
    return toWorkerNodeDto(await this.nodes.heartbeat(userId, id, dto));
  }

  // ---------------------------------------------------------------------------
  // The work itself
  // ---------------------------------------------------------------------------

  @Post(':id/claim')
  @Auth({ permissions: [PERMISSIONS.NODES_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Claim runnable jobs for this node',
    description:
      'Takes up to the node’s declared `concurrency` runnable jobs and marks them running ' +
      'under a server-derived lease, through the same atomic claim the in-process worker uses — ' +
      'so a node and the server never receive the same row. Requested `types` are INTERSECTED ' +
      'with the node’s registered `eligibleTypes` (a node may narrow, never widen) and with the ' +
      'types this server could actually store a node-computed result for. `limit` is clamped ' +
      'down to the node’s live concurrency. A `draining` node gets an empty list; a `disabled` ' +
      'one gets `403`. An empty list is the common, non-error answer.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The claimed jobs and their inputs', type: ClaimJobsResponseDto })
  @ApiResponse({ status: 403, description: 'This node is disabled, or belongs to another user' })
  async claim(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ClaimJobsDto,
    @CurrentUser('id') userId: string
  ): Promise<ClaimJobsResponseDto> {
    const jobs = await this.nodes.claimJobs(userId, id, dto);

    // The renewal cadence is resolved PER JOB, not once per batch: a node
    // claims across several types in one call (#346), and with per-type
    // runtime ceilings those rows no longer share a lease — so they no longer
    // share a renewal interval either.
    return {
      jobs: jobs.map((job) =>
        toNodeJobAssignment(job, this.nodes.renewIntervalMsFor(job.type))
      ),
    };
  }

  @Post(':id/jobs/:jobId/renew')
  @Auth({ permissions: [PERMISSIONS.NODES_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Extend the lease on a held job',
    description:
      'Pushes the job’s lease out by the server’s lease interval so the reaper does not requeue ' +
      'work that is still running. The lease length is derived from the server’s job timeout and ' +
      'is not negotiable: a node that could choose its own lease could park every row it claimed. ' +
      'Refused with `409` once the lease has already expired — by then another executor may own ' +
      'the job, and renewing would keep the reaper away from a run that is no longer this node’s.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'jobId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The new lease expiry', type: RenewLeaseResponseDto })
  @ApiResponse({ status: 409, description: 'This node no longer holds the job with a live lease' })
  async renew(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @CurrentUser('id') userId: string
  ): Promise<RenewLeaseResponseDto> {
    const renewed = await this.nodes.renewLease(userId, id, jobId);

    return { jobId: renewed.jobId, leaseExpiresAt: renewed.leaseExpiresAt.toISOString() };
  }

  // ---------------------------------------------------------------------------
  // The data plane (#269) — bytes move between the node and the storage
  // provider DIRECTLY. Neither route carries a payload, and no storage
  // credential ever leaves this server.
  // ---------------------------------------------------------------------------

  @Post(':id/jobs/:jobId/download-url')
  @Auth({ permissions: [PERMISSIONS.NODES_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mint a short-lived signed GET for a held job’s input object',
    description:
      'Returns a signed URL for the storage object this job names as its subject. Fetch it ' +
      'DIRECTLY from the storage provider: the bytes never pass through this API, and a node ' +
      'never receives a storage credential. The expiry is bounded by the server and is not ' +
      'negotiable — ask again if a transfer needs longer, which is cheap while the lease is ' +
      'live. Treat the URL as a secret and do not log it. `409` once the lease has expired ' +
      '(another executor may own the job — drop the work); `422` when the job names no ' +
      'resolvable input, which is permanent: report the job as FAILED rather than retrying, ' +
      'and `details.reason` says which of `missing_subject_id`, `input_object_not_found` or ' +
      '`input_object_has_no_storage_key` applied.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'jobId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'A signed download URL', type: NodeDownloadUrlResponseDto })
  @ApiResponse({ status: 409, description: 'This node no longer holds the job with a live lease' })
  @ApiResponse({ status: 422, description: 'The job names no resolvable input object' })
  async downloadUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @CurrentUser('id') userId: string
  ): Promise<NodeDownloadUrlResponseDto> {
    return this.dataPlane.createDownloadUrl(userId, id, jobId);
  }

  @Post(':id/jobs/:jobId/upload-url')
  @Auth({ permissions: [PERMISSIONS.NODES_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mint a short-lived signed PUT for a held job’s output',
    description:
      'Returns a signed URL accepting ONE `PUT` of a whole object, plus the storage key the ' +
      'SERVER chose for it. A node may not choose its own key — a signed PUT is an ' +
      'unconditional overwrite of exactly that key, so a node-supplied one would be a write ' +
      'primitive over the whole bucket — and a request carrying `key` (or any field other ' +
      'than `contentType`) is refused with `400` naming it. The key is returned so the node ' +
      'can report it in its result; no `storage_objects` row is created here. If ' +
      '`contentType` is supplied it becomes part of the signature and must be sent verbatim ' +
      'on the PUT. `409` once the lease has expired.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'jobId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'A signed upload URL and its server-chosen key', type: NodeUploadUrlResponseDto })
  @ApiResponse({ status: 400, description: 'The request carried a field a node may not set (e.g. `key`)' })
  @ApiResponse({ status: 409, description: 'This node no longer holds the job with a live lease' })
  async uploadUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() dto: NodeUploadUrlDto,
    @CurrentUser('id') userId: string
  ): Promise<NodeUploadUrlResponseDto> {
    return this.dataPlane.createUploadTarget(userId, id, jobId, dto);
  }

  // ---------------------------------------------------------------------------
  // The secret broker (#349, epic #345) — the ONE credential a job may need,
  // bounded by the lease the node is already renewing, revoked on settlement.
  //
  // ⚠ NO AUTH-GUARD CHANGE WAS REQUIRED, AND THAT IS WORTH VERIFYING RATHER
  // THAN ASSUMING. `JwtAuthGuard` admits a `nod_` credential on `/api/nodes`
  // and every path beneath it (see this file's header and #267), so this route
  // — mounted on the same controller, under the same prefix — is inside that
  // allowlist by construction. Nothing about the allowlist was touched, and
  // nothing should be: the moment a credential route needed a new prefix
  // admitted, the blast radius of a leaked worker token would have grown.
  // `nodes:write`, like every other mint on this controller, for the reason the
  // header gives about `download-url`: handing out a capability scoped by a
  // live lease is not the shape of anything a read-only auditor should do.
  // ---------------------------------------------------------------------------

  @Post(':id/jobs/:jobId/secret')
  @Auth({ permissions: [PERMISSIONS.NODES_WRITE] })
  @HttpCode(HttpStatus.OK)
  // Belt and braces over `POST` already being uncacheable. What comes back is
  // not a scoped URL but a credential, and an intermediary that decided to be
  // clever is one nobody would find out about.
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Obtain the short-lived credential for a held job',
    description:
      'Returns the ONE credential this job’s type declares it needs, valid no longer than ' +
      'this job’s LEASE — the node is already renewing that lease, and the server does not ' +
      'mint a second clock. ⚠ HOLD IT IN MEMORY ONLY: it is returned once, it is revoked ' +
      'when the job settles, and a node must never write it to disk, to an environment ' +
      'variable, or to a log. Re-callable while the lease is live — the same grant is ' +
      'extended, never a second one issued. Send an EMPTY BODY: any field is refused with ' +
      '`400`, because a node may not request a secret it was not assigned. `403` (with ' +
      '`details.reason`) when this deployment does not issue per-job credentials at all; ' +
      '`404` when this job’s type declares no broker, which will not change on a retry; ' +
      '`409` once the lease has expired — drop the work; `503` when the broker exists but ' +
      'cannot mint right now, carrying the operator-facing `remedy` in `details`.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'jobId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The credential, returned once', type: NodeJobSecretResponseDto })
  @ApiResponse({ status: 400, description: 'The request body carried a field a node may not set' })
  @ApiResponse({ status: 403, description: 'This deployment does not issue per-job credentials' })
  @ApiResponse({ status: 404, description: 'This job’s type declares no secret broker' })
  @ApiResponse({ status: 409, description: 'This node no longer holds the job with a live lease' })
  @ApiResponse({ status: 503, description: 'The broker cannot mint a credential in this deployment' })
  async issueSecret(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() dto: NodeJobSecretRequestDto,
    @CurrentUser('id') userId: string
  ): Promise<NodeJobSecretResponseDto> {
    return this.secrets.issueForJob(userId, id, jobId, dto);
  }

  @Post(':id/jobs/:jobId/result')
  @Auth({ permissions: [PERMISSIONS.NODES_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit a computed result for a held job',
    description:
      'The server validates the result against the handler’s `nodeResultSchema`, persists it ' +
      'through `persistNodeResult`, and settles the job — the node never writes to the database. ' +
      '`400` if the declared `type` does not match the job, if the type is not node-persistable, ' +
      'or if the result fails validation (the issues are in `details`); `409` if the lease has ' +
      'expired, in which case nothing is persisted and the node should drop the work; `500` if ' +
      'persisting threw, in which case the server has ALREADY settled the job through its normal ' +
      'failure path and the node must not resubmit.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'jobId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The job was settled', type: JobSettlementResponseDto })
  @ApiResponse({ status: 400, description: 'Wrong type, not node-persistable, or invalid result' })
  @ApiResponse({ status: 409, description: 'This node no longer holds the job with a live lease' })
  async submitResult(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() dto: NodeJobResultDto,
    @CurrentUser('id') userId: string
  ): Promise<JobSettlementResponseDto> {
    return this.nodes.submitResult(userId, id, jobId, dto);
  }

  @Post(':id/jobs/:jobId/failure')
  @Auth({ permissions: [PERMISSIONS.NODES_WRITE] })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Report that a held job failed',
    description:
      'The failure goes through the same terminal state machine an in-process handler’s throw ' +
      'does: `rateLimited` is treated exactly as a thrown rate-limit error (it defers rather ' +
      'than charging an attempt, and it backs off sibling jobs on this server too), and ' +
      '`retryAfterMs` is a floor on the backoff. `willRetry` in the REQUEST is advisory and is ' +
      'not acted on — the server’s attempt budget decides, and `willRetry` in the RESPONSE is ' +
      'that decision.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiParam({ name: 'jobId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The job was settled', type: JobSettlementResponseDto })
  @ApiResponse({ status: 409, description: 'This node no longer holds the job with a live lease' })
  async reportFailure(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() dto: NodeJobFailureDto,
    @CurrentUser('id') userId: string
  ): Promise<JobSettlementResponseDto> {
    return this.nodes.reportFailure(userId, id, jobId, dto);
  }
}

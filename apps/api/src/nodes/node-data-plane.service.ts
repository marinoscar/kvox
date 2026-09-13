// =============================================================================
// The node DATA plane: how a node with no credentials moves bytes
// (issue #269, epic #254)
// =============================================================================
//
// #268's control plane answers "which work is mine, and what did I conclude
// about it". It has one hole, and it is not a small one: a worker node holds
// NO STORAGE CREDENTIALS, so a job whose input is a stored object is a job the
// node cannot start and a job whose output is bytes is a job it cannot finish.
// This service is the sanctioned way across that gap, and it is deliberately
// the ONLY way.
//
// THE INVARIANT: BYTES NEVER TOUCH THE API PROCESS. The server mints a
// short-lived signed URL; the node talks to the storage provider directly.
// No storage credential ever leaves this process, and no object payload ever
// enters it. `dto/node-data-plane.dto.ts`'s header records the two
// alternatives this beats — proxying every byte through the API, and handing
// nodes a bucket-wide credential — and why each is worse.
//
// -----------------------------------------------------------------------------
// WHY THIS IS A SEPARATE SERVICE FROM `NodesService`
// -----------------------------------------------------------------------------
//
// Because of what it would otherwise DRAG IN. `NodesService` is the control
// plane: Prisma, the claim, the terminal state machine, the registry.
// Injecting `STORAGE_PROVIDER` there would make the queue's second executor
// depend on object storage being configured at all — and #268 was careful in
// the other direction, keeping the node plane out of `JobsModule` so "the
// queue does not need to know that nodes exist" stays true. Same argument,
// one layer out: the control plane does not need to know that storage exists.
// A deployment with no bucket still registers nodes, claims jobs and settles
// them; only this service is inert.
//
// It also keeps the guard where it belongs. Both routes here are behind
// `NodesService.assertJobHeldByNode` — REUSED, never reimplemented. That
// method demands four things at once (claimed by THIS node, `running`, with a
// lease, unexpired), and it is the single reason a straggler's late request
// cannot mint a URL for a job somebody else now owns. A second copy of the
// check written here would start identical and drift on the first fix applied
// to one side, and the failure it would let through is invisible: a node
// reading or overwriting an object for a job it no longer holds, with nothing
// in any log connecting the two.
//
// -----------------------------------------------------------------------------
// ⚠ THE DOWNLOAD IS RESOLVED THROUGH AN *INTERNAL* PATH, WITH NO OWNERSHIP CHECK
// -----------------------------------------------------------------------------
//
// `ObjectsService.getDownloadUrl` exists and is NOT used here, on purpose. It
// applies a per-user ownership check (`uploadedById !== userId → 403`) because
// its caller is a person asking for their own file over the interactive API.
// This caller is not that. A node is a TRUSTED INTERNAL EXECUTOR running work
// the server itself assigned it, and the ownership question was already
// settled twice before we arrive here: the job was enqueued by this
// application against a subject it chose, and `assertJobHeldByNode` proved
// this node currently holds that job under a live lease.
//
// Applying the user check anyway would not add safety; it would add a bug. The
// user a `nod_` credential resolves to is the node's OWNER — the operator who
// registered the machine — who has no relationship whatsoever to whoever
// uploaded the object a job happens to be about. Every job over another
// user's upload would fail with a `403` that is simply wrong, and the fleet
// would appear to work perfectly right up until the first cross-user job.
//
// THE POSTURE IS EXACTLY THE IN-PROCESS WORKER'S. When `JobWorker` runs
// `ExampleChecksumHandler.process`, the handler calls
// `storageProvider.download(key)` and reads the bytes with no ownership check
// at all, because a background job is not acting on behalf of a user. A node
// is the same executor on different hardware; giving the two different access
// rules would mean a job's outcome depended on which one claimed it. What
// bounds a node is not ownership, it is the LEASE: it may read exactly the
// input of exactly the job it is holding, for as long as it holds it.
//
// -----------------------------------------------------------------------------
// WHY URLS ARE MINTED HERE AND NOT FOLDED INTO THE CLAIM RESPONSE
// -----------------------------------------------------------------------------
//
// #268's `params` bag was built to receive them ("tomorrow (#269) is that plus
// presigned URLs"), and they are still not there. Minting at claim time spends
// the URL's lifetime on the wrong clock: a node claiming its `concurrency` in
// one call queues that work internally, so the last job's URL has been ageing
// since before the first job started — and the fix, a longer expiry, widens
// the very window the short expiry exists to close. On-demand minting means a
// URL's clock starts when the transfer does. It also means a job whose type
// never touches storage carries no storage cost at all, and that a retried
// transfer is one cheap call rather than a re-claim.
// =============================================================================

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { JobHandlerRegistry } from '../jobs/job-handler.registry';
import { PrismaService } from '../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../storage/providers/storage-provider.interface';
import type { StorageProvider } from '../storage/providers/storage-provider.interface';
import {
  JobInputResolutionError,
  resolveStorageObjectInput,
} from '../storage/storage-job-input';
import {
  NodeDownloadUrlResponseDto,
  NodeUploadUrlDto,
  NodeUploadUrlResponseDto,
} from './dto/node-data-plane.dto';
import { NodesService } from './nodes.service';

/**
 * The longest a node-facing signed URL may live, in seconds.
 *
 * FIFTEEN MINUTES, AND IT IS A CEILING RATHER THAN A SETTING. The
 * application-wide `storage.signedUrlExpiry` defaults to an hour, which is the
 * right answer for a URL handed to a logged-in person's browser and the wrong
 * one for a URL handed to an unattended process on hardware this deployment
 * may not own. A signed URL is a bearer capability: whoever holds the string
 * has it, so the only thing bounding the damage of one that leaks — into a
 * node's own debug log, a crash dump, a support ticket, a shell history — is
 * how long it stays valid.
 *
 * Fifteen minutes is long enough for a large object over a slow link and short
 * enough that a leaked URL is worthless by the time anyone finds it. A node
 * that needs longer asks again, which costs one request and is available for
 * as long as it holds the lease.
 */
export const NODE_SIGNED_URL_MAX_TTL_SECONDS = 900;

/**
 * The shortest a node-facing signed URL may live.
 *
 * Guards against a deployment that sets `SIGNED_URL_EXPIRY=0` (or something
 * negative, or unparseable) and thereby hands its whole fleet URLs that expire
 * before the node can use them — a fleet-wide outage produced by a config
 * typo, whose symptom is every transfer failing with a provider-side
 * "expired" error that names nothing about this setting.
 */
export const NODE_SIGNED_URL_MIN_TTL_SECONDS = 60;

/**
 * The prefix every node-written output lands under.
 *
 * One namespace, separate from `uploads/` where `ObjectsService` puts
 * user-uploaded objects, so "what did the fleet write" is answerable with a
 * single prefix listing and a lifecycle rule can be applied to node output
 * without touching a single user upload.
 */
export const NODE_OUTPUT_KEY_PREFIX = 'node-outputs';

/**
 * What a server-derived storage key is allowed to contain.
 *
 * ⚠ THIS IS NOW LOAD-BEARING, NOT DEFENSIVE (#348). It used to assert a
 * property this file guaranteed on its own: the key was a UUID path parameter
 * plus a `randomUUID()`, so it could not contain anything else, and the regex
 * was insurance against a future edit interpolating something less
 * disciplined into that template. Since #348 the key may come from a
 * handler's `deriveOutputKey`, which is arbitrary application code computing
 * a path — a job type, a payload field, a timestamp formatted by hand, a
 * name read out of a row — so this is the only check standing between that
 * computation and a signed PUT.
 *
 * Path traversal does not announce itself: `..` in an S3 key is not an error,
 * it is a key, and the object simply lands somewhere nobody looks. The
 * leading-character rule additionally refuses a key starting with `/`, which
 * some providers accept and then store under a different name than the one
 * the handler recorded.
 */
const SAFE_STORAGE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

@Injectable()
export class NodeDataPlaneService {
  private readonly logger = new Logger(NodeDataPlaneService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly nodes: NodesService,
    @Inject(STORAGE_PROVIDER)
    private readonly storage: StorageProvider,
    // The registry, for exactly one question: does this job's type want to
    // choose its own output key (#348)? Injected rather than imported so the
    // answer comes from the handlers actually registered in THIS process —
    // the same source `serverOnlyTypes()` and the claim already read.
    private readonly registry: JobHandlerRegistry
  ) {}

  // ===========================================================================
  // Reading the input
  // ===========================================================================

  /**
   * A short-lived signed GET for the input object of a job this node holds.
   *
   * THE ORDER IS THE CONTRACT, and it is the same discipline `submitResult`
   * follows: prove the caller may speak for this job, THEN resolve what the
   * job is about, THEN mint. Nothing is minted for a job whose lease has
   * lapsed, and nothing is minted for a job whose input cannot be named.
   *
   * ⚠ THE URL IS NEVER LOGGED. Not at `debug`, not on the error path, not
   * "temporarily". It is a bearer capability for the object, and a log line is
   * the easiest place in a system for one to be copied to somewhere it
   * outlives its expiry. The log below names the job and the object, which is
   * everything an operator needs to trace a transfer and nothing that grants
   * access to it. `S3StorageProvider.getSignedDownloadUrl` holds to the same
   * rule from its side, and the HTTP interceptor records method, url and
   * duration only — never a response body.
   */
  async createDownloadUrl(
    userId: string,
    nodeId: string,
    jobId: string
  ): Promise<NodeDownloadUrlResponseDto> {
    const job = await this.nodes.assertJobHeldByNode(userId, nodeId, jobId);
    const object = await this.resolveInput(job);

    const expiresIn = this.resolveTtlSeconds();

    const url = await this.storage.getSignedDownloadUrl(object.storageKey, {
      expiresIn,
    });

    this.logger.log(
      `Issued a ${expiresIn}s download URL to node ${nodeId} for job ${job.id} ` +
        `(${job.type}), storage object ${object.id}`
    );

    return {
      url,
      expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      objectId: object.id,
      size: object.size.toString(),
      mimeType: object.mimeType,
    };
  }

  // ===========================================================================
  // Writing the output
  // ===========================================================================

  /**
   * A short-lived signed PUT to a key THIS SERVER CHOSE, for a job this node
   * holds.
   *
   * The key derivation is the security-relevant line and it takes no input
   * from the request. The DEFAULT is `node-outputs/<jobId>/<uuid>`: the job id
   * is a UUID the router already validated, the suffix is a fresh
   * `randomUUID()`. Two consequences worth stating, because both are
   * load-bearing:
   *
   *   * A NODE CANNOT OVERWRITE ANYTHING. The random suffix means every mint
   *     is a new key, so even the same node asking twice for the same job
   *     cannot clobber its own earlier output — let alone somebody else's
   *     upload. A signed PUT is an unconditional overwrite of its key, so
   *     "the key is always new" is the whole of that guarantee.
   *   * THE OUTPUT IS ATTRIBUTABLE. The job id is in the path, so an object
   *     found in the bucket months later can be traced to the row that
   *     produced it without a lookup table.
   *
   * ⚠ A TYPE MAY OVERRIDE WHERE ITS OUTPUT LANDS, AND THE SERVER STILL CHOOSES
   * (#348). A handler implementing `deriveOutputKey` answers instead of the
   * template above, because some artifacts have a REQUIRED location: a
   * database backup's key is recorded on its `database_backup_runs` row and
   * read back by the retention sweep, the download endpoint and the restore
   * path, so an archive under `node-outputs/…` is one none of them can find.
   * Without this, no such type could ever be node-eligible.
   *
   * What does NOT change is who decides. `deriveOutputKey` runs in this
   * process, in the handler that owns the artifact, with the `Job` row as its
   * only input; the node's influence remains exactly zero. It is also the
   * handler's job to be IDEMPOTENT — a node that asks twice (a retry, a lost
   * response) must get the same key back rather than a second artifact; see
   * `JobHandler.deriveOutputKey`. Note the trade that buys: a handler that
   * derives a STABLE key gives up the "every mint is a new key" guarantee
   * above for its own type, deliberately, because a stable location is the
   * whole point — the overwrite it can then perform is of its own artifact,
   * for its own job, and of nothing else.
   *
   * A `key` in the request body is REFUSED, not ignored — see the DTO file's
   * header for why the node's author being told beats the node's author
   * guessing. That refusal is unchanged by the above and happens BEFORE any
   * derivation runs.
   *
   * NO `storage_objects` ROW IS CREATED HERE. Minting a write target is not
   * the same as recording an object: the node may never use the URL, may
   * crash mid-transfer, or may have its lease expire and its result refused,
   * and a row written now would outlive all three as a `pending` object with
   * nothing behind it. Recording the output is the HANDLER's business, in
   * `persistNodeResult`, after the bytes are known to exist — which is why the
   * chosen key is returned to the node rather than kept: the node reports it
   * back in its result, and the handler writes it down.
   */
  async createUploadTarget(
    userId: string,
    nodeId: string,
    jobId: string,
    dto: NodeUploadUrlDto
  ): Promise<NodeUploadUrlResponseDto> {
    const job = await this.nodes.assertJobHeldByNode(userId, nodeId, jobId);

    this.rejectCallerSuppliedFields(job, dto);

    // The type's own answer if it has one, the data plane's default if it does
    // not. `?.` twice, not a branch: a job whose type has no registered
    // handler at all (a row left by a fork's handler that is no longer in this
    // process) still gets a usable key rather than a crash on the way to one.
    const handler = this.registry.get(job.type);
    const key =
      (await handler?.deriveOutputKey?.(job)) ??
      `${NODE_OUTPUT_KEY_PREFIX}/${job.id}/${randomUUID()}`;

    if (!SAFE_STORAGE_KEY.test(key)) {
      // ⚠ REACHABLE SINCE #348, and this is the check that makes
      // `deriveOutputKey` safe to hand to arbitrary handlers: the value above
      // may now be a path some feature's code computed, and `..`, a leading
      // `/` or a stray space in it is not an error at the provider — it is a
      // key, and the bytes land somewhere nobody looks.
      //
      // A 500 rather than a 400, deliberately: nothing the node sent can
      // reach this string, so a 4xx would tell an operator to go and fix a
      // node that is behaving perfectly. The fault is in a handler in this
      // process, and the log line below names the type so the search starts
      // in the right file.
      this.logger.error(
        `Handler for job type ${job.type} derived an unsafe storage key for job ${job.id}; ` +
          `refusing to sign an upload. Fix the handler's deriveOutputKey.`
      );

      throw new Error(
        `Refusing to sign an upload for job ${job.id}: the derived storage key is not safe.`
      );
    }

    const expiresIn = this.resolveTtlSeconds();

    const url = await this.storage.getSignedPutUrl(key, {
      expiresIn,
      contentType: dto.contentType,
    });

    this.logger.log(
      `Issued a ${expiresIn}s upload URL to node ${nodeId} for job ${job.id} ` +
        `(${job.type}), key ${key}`
    );

    return {
      url,
      key,
      expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  /**
   * The job's input object, or a clean 422 naming exactly what is missing.
   *
   * THIS IS THE `ENOENT … open ''` FIX, EXPRESSED OVER HTTP.
   * `resolveStorageObjectInput` refuses to produce an empty path and throws
   * one of three named reasons instead (see `storage-job-input.ts`); this
   * method's only job is to turn that into a status code a node can act on.
   *
   * WHY 422 AND NOT 400, 404 OR 500 — the status is the instruction, exactly
   * as it is for the 409 in #268:
   *
   *   * `400` would say "your request was malformed". It was not: the node
   *     sent the right thing about the right job. A node written to fix and
   *     resend a 4xx would resend forever.
   *   * `404` would say "no such job", which is false and sends the operator
   *     hunting for a job that is right there in the admin list.
   *   * `500` would say "this server is broken, try again". It is not, and a
   *     retry cannot help: all three reasons are permanent (a subject that was
   *     never set does not appear later; a deleted row does not come back).
   *   * `422` says "your request was understood and cannot be processed",
   *     which is the truth. The node's correct response is to report the job
   *     FAILED through `POST …/failure`, letting the attempt budget and the
   *     admin job list surface it the way every other permanent failure
   *     surfaces — with `details.reason` naming which of the three it was.
   */
  private async resolveInput(job: Job) {
    try {
      return await resolveStorageObjectInput(this.prisma, job);
    } catch (error) {
      if (!(error instanceof JobInputResolutionError)) {
        throw error;
      }

      this.logger.warn(
        `Job ${job.id} (${job.type}) has no resolvable input: ${error.message}`
      );

      throw new UnprocessableEntityException({
        message: error.message,
        details: {
          jobId: job.id,
          type: job.type,
          reason: error.reason,
          subjectId: error.subjectId,
          // Said explicitly because it is the one thing a node cannot work
          // out for itself, and getting it wrong costs an attempt per lap.
          retryable: false,
          action: 'report this job as failed; it cannot succeed on a retry',
        },
      });
    }
  }

  /**
   * Refuses any field the node is not permitted to choose — today, anything
   * beyond `contentType`.
   *
   * The `key` case is the one that matters and the message says so by name.
   * Everything else is caught by the same net rather than by a growing list of
   * individual checks: a field this endpoint does not understand is a field
   * the node believes has an effect and which is having none, and that belief
   * is the bug. Naming the offending keys turns "my output went somewhere
   * else" into "the server told me on the first run".
   */
  private rejectCallerSuppliedFields(job: Job, dto: NodeUploadUrlDto): void {
    const permitted = new Set(['contentType']);
    const offending = Object.keys(dto ?? {}).filter((key) => !permitted.has(key));

    if (offending.length === 0) {
      return;
    }

    this.logger.warn(
      `Node upload request for job ${job.id} carried field(s) it may not set: ` +
        `[${offending.join(', ')}]. Refused.`
    );

    throw new BadRequestException({
      message:
        `This request carried field(s) a node may not set: ${offending.join(', ')}. ` +
        `The storage key for a node's output is chosen by the server — a node-supplied key ` +
        `would be an unconditional overwrite of any object in the bucket. Send no key; the ` +
        `one the server chose is returned as "key" in a successful response.`,
      details: { jobId: job.id, rejectedFields: offending, permittedFields: [...permitted] },
    });
  }

  /**
   * How long a node-facing signed URL lives, clamped into
   * `[NODE_SIGNED_URL_MIN_TTL_SECONDS, NODE_SIGNED_URL_MAX_TTL_SECONDS]`.
   *
   * READS THE APPLICATION SETTING AND THEN OVERRIDES IT DOWNWARD, which is
   * deliberate rather than lazy. An operator who shortens
   * `SIGNED_URL_EXPIRY` for the interactive API means it for the fleet too, so
   * the setting is honoured when it is stricter; an operator who lengthens it
   * to an hour for browser downloads did not mean "hand hour-long bucket
   * capabilities to unattended machines", so the ceiling wins. There is no
   * separate node-only environment variable, because a second knob is a second
   * thing to get wrong and its only correct values are already inside this
   * range.
   */
  private resolveTtlSeconds(): number {
    const configured = this.config.get<number>(
      'storage.signedUrlExpiry',
      NODE_SIGNED_URL_MAX_TTL_SECONDS
    );

    const seconds = Number.isFinite(configured)
      ? Math.floor(configured)
      : NODE_SIGNED_URL_MAX_TTL_SECONDS;

    return Math.min(
      NODE_SIGNED_URL_MAX_TTL_SECONDS,
      Math.max(NODE_SIGNED_URL_MIN_TTL_SECONDS, seconds)
    );
  }
}

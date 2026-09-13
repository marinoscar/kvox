// =============================================================================
// The node control plane (issue #268, epic #254)
// =============================================================================
//
// THE ONE CONSTRAINT THAT SHAPES EVERY DECISION IN THIS FILE: a worker node
// has no database access and no storage credentials. Every fact it needs
// arrives in an HTTP response, and every fact it produces is validated here
// before anything is trusted. It is authenticated (a `nod_` credential
// resolves to its owning user) but it is not trusted the way an in-process
// caller is: it runs unattended on a machine this deployment may not own, its
// configuration is editable by whoever holds that machine, and it may be
// running an older build than the server it is talking to.
//
// This service is therefore where the queue gains a SECOND EXECUTOR — and the
// whole point of the design is that the second executor reuses the first
// one's machinery rather than acquiring its own.
//
// -----------------------------------------------------------------------------
// WHAT THIS SERVICE DELIBERATELY DOES NOT CONTAIN
// -----------------------------------------------------------------------------
//
// REJECTED: a claim query of its own. `JobClaimService.claim` already carries
// `nodeId` and `executor` as parameters precisely so both claimers share ONE
// `UPDATE … FOR UPDATE SKIP LOCKED … RETURNING` statement. A node-flavoured
// copy would start identical and diverge on the first fix applied to one
// side, and the property that would break is the one nothing tests by
// accident: two claimers never receiving the same row. The in-process worker
// and this service pass different arguments to the same statement, and that
// is the entire difference between them.
//
// REJECTED: a terminal update of its own. `JobTerminalService` is the single
// chokepoint that decides what happens to a row that stopped running — retry,
// defer, fail — and its header spells out what drifts when two executors each
// write their own: whether a 429 charges an attempt, whether the settled
// event fires, what the backoff is. A node reports a CONCLUSION as flags
// (`rateLimited`, `retryAfterMs`) because an exception cannot cross HTTP, and
// `completeFailed` gives those flags the identical treatment it gives a
// thrown `RateLimitError`. So this service classifies nothing.
//
// REJECTED: trusting the node's `willRetry`. A node that has just read a
// provider's response often does know whether the work is worth retrying, and
// it may say so — but the server's attempt budget decides. A node that could
// dictate its own retries could retry itself past a budget that exists
// precisely to bound a job nobody is watching, and the crash-loop that budget
// prevents would come back on hardware the operator cannot see. The flag is
// accepted, recorded in the API contract as advisory, and never read.
//
// REJECTED: per-job provider-credential brokering, and a model manifest.
// The application this design was extracted from hands a node short-lived
// provider credentials per job, and publishes a manifest of model versions
// the fleet must agree on. Both exist for ML compute this template does not
// have; porting them would ship an unused secret-distribution path — the most
// expensive kind of code to carry unused. See docs/specs/worker-nodes.md.
//
// -----------------------------------------------------------------------------
// TWO GUARDS, AND THEY ARE AUTHORITATIVE RATHER THAN DECORATIVE
// -----------------------------------------------------------------------------
//
// `assertOwnership` and `assertJobHeldByNode` are not "checks the controller
// does first"; they are the only reason the routes below are safe, and every
// route that touches a node or a job goes through one of them. Both return
// the row they verified, so no caller needs a second fetch and no caller can
// accidentally act on a DIFFERENT row than the one that was checked.
//
// `assertOwnership` answers 404 for a node that does not exist and 403 for
// one that belongs to somebody else. That deliberately DIFFERS from
// `NodeCredentialService.revokeCredential` next door, which folds ownership
// into the lookup so "not yours" and "does not exist" are indistinguishable —
// and the difference is worth stating because the reasoning is not the same
// on both sides. A credential ID is a secret-adjacent handle: distinguishing
// the two would let a caller enumerate other users' credential IDs, and there
// is no operational cost to hiding it, because nobody ever legitimately holds
// a credential ID they do not own.
//
// REJECTED for nodes: 404-for-another-user's-node. A node id is not secret —
// it is printed in logs, embedded in a worker's config file, and passed
// around by operators — and a node OPERATOR legitimately holds ids they do
// not own (a colleague's node in the same deployment, a node registered
// before an ownership change). The realistic failure here is not enumeration,
// it is misconfiguration: a `nod_` credential paired with the wrong node id
// in a config file. `404` tells that operator "this node does not exist",
// which is false and sends them to re-register — leaking a duplicate row and
// leaving the real node's jobs stranded. `403` tells them the truth: the node
// exists and this credential is not the one that owns it. A boundary that
// lies produces worse operational outcomes than one that says no.
//
// `assertJobHeldByNode` is the more important of the two. It is reused by
// `result`, `failure` and `renew`, and it demands FOUR things: the job is
// claimed by THIS node, it is `running`, it has a lease, and that lease has
// not expired.
//
// ⚠ THE LEASE CHECK IS WHAT MAKES A LATE SUBMISSION HARMLESS. Consider the
// ordinary sequence: a node's machine sleeps, its lease expires, the reaper
// (#263) requeues the job, another executor claims it and starts running it —
// and then the original node wakes up and posts the result it computed twenty
// minutes ago. Without the lease check that result is persisted over a newer
// run: `persistNodeResult` writes stale output, `completeSucceeded` marks a
// row terminal that another executor is still actively working on, and that
// executor's own terminal write lands afterwards on a job it no longer owns.
// The observable damage is a permanently wrong stored result and a duplicated
// side effect, with nothing in any log tying the two together.
//
// REJECTED: answering a late submission with 400. The distinction is not
// pedantry — it is the instruction the node acts on. `400` means "your
// request was malformed", and the reasonable client response is to fix and
// resend; a node that resends will be refused forever, and a node written to
// treat 4xx as retriable will hammer the endpoint. `409 Conflict` means "the
// server's state moved on", and the correct node behaviour is to DROP THE
// WORK: the job is not its problem any more, somebody else owns it. That is
// the whole message, and only one status code carries it.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, NodeStatus, Prisma, WorkerNode } from '@prisma/client';
import { z } from 'zod';

import { JobClaimService } from '../jobs/job-claim.service';
import {
  buildClaimLeases,
  resolveJobProfile,
  resolveRenewIntervalMs,
} from '../jobs/job-execution-profile';
import { JobHandlerRegistry } from '../jobs/job-handler.registry';
import { NodeOffloadService } from '../jobs/node-offload.service';
import { JobLeaseService } from '../jobs/job-lease.service';
import { jobTypeLabel } from '../jobs/job-type-labels';
import { JobSettleOutcome, JobTerminalService } from '../jobs/job-terminal.service';
import { resolveJobLeaseMs } from '../jobs/job.worker';
import { PrismaService } from '../prisma/prisma.service';
import {
  ClaimJobsDto,
  HeartbeatNodeDto,
  NodeJobFailureDto,
  NodeJobResultDto,
  RegisterNodeDto,
} from './dto/node-control-plane.dto';

/**
 * How recently a node must have heartbeated for a re-register to be WORTH
 * MENTIONING in the log.
 *
 * It is a warning threshold and nothing else — no request is refused by it.
 * See `register` for why last-writer-wins is the policy, and why this number
 * being wrong costs a log line rather than an outage.
 */
const FRESH_HEARTBEAT_WARN_MS = 60_000;

/** What `register` reports back: the row, and whether it already existed. */
export interface NodeRegistration {
  node: WorkerNode;
  reattached: boolean;
}

/**
 * One node-eligible job type as `GET /nodes/job-types` publishes it.
 *
 * Declared here rather than imported from the DTO file so this service keeps
 * describing what it KNOWS rather than what a controller happens to render —
 * the same reason the mappers in `dto/node-response.dto.ts` are the only place
 * a Prisma row becomes a wire shape.
 */
export interface NodeEligibleJobType {
  type: string;
  label: string;
  /** JSON Schema for the result, or `null` when the schema cannot be published. */
  resultSchema: Record<string, unknown> | null;
}

/** What a settled job reports back to the node that settled it. */
export interface NodeJobSettlement {
  jobId: string;
  outcome: JobSettleOutcome;

  /**
   * Whether the job will run again — THE SERVER'S ANSWER. A node may send
   * `willRetry` on a failure; this is what the attempt budget actually
   * decided, which is the only version of that question anybody should act
   * on.
   */
  willRetry: boolean;
}

/**
 * Whether a thrown value is Postgres's unique-violation, as Prisma reports it.
 *
 * DUCK-TYPED ON `code` RATHER THAN `instanceof PrismaClientKnownRequestError`.
 * `instanceof` across a re-exported generated client is a classic
 * false-negative — two copies of `@prisma/client` in a dependency tree, a
 * mocked module in a test, a driver adapter that wraps the error — and the
 * cost of a false negative here is not a nicer error message: it is
 * `register` giving up on a race it knows how to recover from, and a restarted
 * container failing to reattach. The string `'P2002'` is Prisma's documented,
 * stable error code.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/** Zod's issue list, flattened to something a node can print. */
function describeValidationError(error: unknown): unknown {
  const issues = (error as { issues?: unknown }).issues;

  if (Array.isArray(issues)) {
    return issues.map((issue: { path?: unknown[]; message?: string }) => ({
      path: Array.isArray(issue.path) ? issue.path.join('.') : '',
      message: issue.message ?? 'Invalid value',
    }));
  }

  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class NodesService {
  private readonly logger = new Logger(NodesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly claims: JobClaimService,
    private readonly terminal: JobTerminalService,
    // The renewal half of the claim (#347), shared verbatim with the
    // in-process worker. See `renewLease` for why the guard it carries must
    // not be written twice.
    private readonly leases: JobLeaseService,
    private readonly registry: JobHandlerRegistry,
    // WHAT A NODE MAY CLAIM HERE, RIGHT NOW (#349, #352). It replaced a
    // `NodeLifecycleService` injected for one settings field, because the
    // question grew two more gates and — critically — acquired a SECOND
    // READER: `JobWorker`'s `system` mode consumes the complement of this
    // exact set. See `nodeEligibleTypes` below, and the service's own header
    // for the partition argument.
    private readonly offload: NodeOffloadService
  ) {}

  // ===========================================================================
  // Registration
  // ===========================================================================

  /**
   * Registers a node, or REATTACHES to the one this owner already has under
   * this name.
   *
   * ⚠ IDEMPOTENT ON `(createdById, name)`, and that is the entire reason the
   * composite unique index exists. Without it, every restart of a worker
   * container — a deploy, an OOM kill, a host reboot, a `docker compose up`
   * after an edit — leaks a new `worker_nodes` row. Within a week the fleet
   * page is a list of ghosts, `GET /nodes` is unreadable, and the operator
   * cannot tell which row is the machine currently doing work. Reattaching
   * makes a restart a non-event: same row, same id, refreshed facts.
   *
   * FIND, THEN CREATE, THEN RECOVER FROM P2002. The find covers the ordinary
   * restart. The `P2002` branch covers the case the find cannot: two API
   * replicas (or two node processes racing on startup) both find nothing and
   * both insert, and exactly one of them loses. Losing that race is not an
   * error — the row it wanted now exists — so it re-reads and reattaches to
   * it. REJECTED: a `$transaction` with `SERIALIZABLE` isolation to make the
   * race impossible. It would serialise an endpoint every node in the fleet
   * calls at startup in order to avoid an outcome that is already correct
   * when it happens; the unique index is the guarantee, and this is just
   * reading it.
   *
   * A FRESH HEARTBEAT WARNS BUT PROCEEDS. If the existing row heartbeated
   * seconds ago, two processes may genuinely be claiming the same node
   * identity — but the overwhelmingly common cause is a container that was
   * killed and recreated before its last heartbeat aged out, which is exactly
   * the case this endpoint exists to handle gracefully. Refusing would turn
   * the NORMAL restart into a hard failure at startup, on a machine with
   * nobody watching, and the operator's only recovery would be to wait or to
   * invent a new name (leaking the row we just avoided leaking). So the
   * documented policy is LAST-WRITER-WINS, with a log line naming both hosts
   * so a genuine duplicate is visible to whoever goes looking.
   */
  async register(userId: string, dto: RegisterNodeDto): Promise<NodeRegistration> {
    const existing = await this.findByName(userId, dto.name);

    if (existing) {
      return { node: await this.reattach(existing, dto), reattached: true };
    }

    try {
      const node = await this.prisma.workerNode.create({
        data: {
          name: dto.name,
          hostname: dto.hostname,
          platform: dto.platform,
          cliVersion: dto.cliVersion,
          eligibleTypes: dto.eligibleTypes,
          concurrency: dto.concurrency,
          status: NodeStatus.online,
          createdById: userId,
          ...(dto.capabilities === undefined
            ? {}
            : { capabilities: dto.capabilities as Prisma.InputJsonValue }),
        },
      });

      this.logger.log(
        `Registered worker node ${node.id} ("${node.name}" on ${node.hostname}, ` +
          `concurrency ${node.concurrency}, types [${node.eligibleTypes.join(', ')}])`
      );

      return { node, reattached: false };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      // Somebody else won the insert between our find and our create. The row
      // we wanted exists; reattach to it instead of failing a startup.
      const raced = await this.findByName(userId, dto.name);

      if (!raced) {
        // A P2002 with no row behind it means the constraint that fired was
        // not the one we think it was. Re-throw rather than inventing a
        // recovery for a conflict we cannot see.
        throw error;
      }

      this.logger.warn(
        `Concurrent registration of node "${dto.name}" for user ${userId}; ` +
          `reattaching to the row that won (${raced.id}).`
      );

      return { node: await this.reattach(raced, dto), reattached: true };
    }
  }

  /**
   * Refreshes an existing row from a fresh registration.
   *
   * ⚠ `disabled` SURVIVES A REATTACH. Everything else about the row is
   * overwritten by what the node just reported, and the status goes back to
   * `online` — except when an operator has disabled this node, in which case
   * the status is left exactly as it is. `disabled` is the kill switch: it is
   * how an operator says "this machine must not take work", and a node that
   * could clear it by restarting would make the switch defeatable with
   * `docker restart` — by the very process being switched off. The claim
   * endpoint refuses a disabled node, so preserving the status here is what
   * makes that refusal permanent rather than one restart long.
   *
   * `draining` is NOT preserved, and the asymmetry is deliberate: draining
   * means "finish what you are holding and take nothing new", which is a
   * statement about the process that WAS running. A re-register is a new
   * process that holds nothing, so there is nothing left to drain and keeping
   * the flag would silently produce a node that heartbeats forever and never
   * claims.
   */
  private async reattach(existing: WorkerNode, dto: RegisterNodeDto): Promise<WorkerNode> {
    const lastHeartbeat = existing.lastHeartbeatAt;

    if (lastHeartbeat && Date.now() - lastHeartbeat.getTime() < FRESH_HEARTBEAT_WARN_MS) {
      this.logger.warn(
        `Node "${existing.name}" (${existing.id}) re-registered from ${dto.hostname} while ` +
          `its previous registration on ${existing.hostname} was still heartbeating ` +
          `(${lastHeartbeat.toISOString()}). Proceeding: last writer wins. If this repeats, ` +
          `two processes are sharing one node name.`
      );
    }

    return this.prisma.workerNode.update({
      where: { id: existing.id },
      data: {
        hostname: dto.hostname,
        platform: dto.platform,
        cliVersion: dto.cliVersion,
        eligibleTypes: dto.eligibleTypes,
        concurrency: dto.concurrency,
        ...(existing.status === NodeStatus.disabled ? {} : { status: NodeStatus.online }),
        ...(dto.capabilities === undefined
          ? {}
          : { capabilities: dto.capabilities as Prisma.InputJsonValue }),
      },
    });
  }

  /**
   * Marks a node offline on a graceful shutdown.
   *
   * ⚠ IT DOES NOT TOUCH THE JOBS THE NODE IS HOLDING, and that is the whole
   * decision in this method. Requeueing them here is the obvious "helpful"
   * addition and it is wrong: `deregister` is an HTTP call a node makes while
   * shutting down, and nothing proves the work has actually stopped — a
   * process handling SIGTERM may still be mid-write, and a node whose
   * shutdown is interrupted may not stop at all. Requeueing on the node's
   * say-so would hand a still-running job to a second executor and duplicate
   * whatever it does.
   *
   * The component that is allowed to decide a claim is dead is the lease
   * reaper (#263), and it decides it the only way that is safe: by the lease
   * having expired. A deregistered node's jobs therefore come back one lease
   * later, which is exactly what happens when a node crashes instead of
   * shutting down politely — one path, tested once, with no way for a
   * cooperative node to reach a state an uncooperative one cannot.
   */
  async deregister(userId: string, nodeId: string): Promise<WorkerNode> {
    const node = await this.assertOwnership(userId, nodeId);

    this.logger.log(`Node ${node.id} ("${node.name}") deregistered`);

    return this.prisma.workerNode.update({
      where: { id: node.id },
      data: { status: NodeStatus.offline },
    });
  }

  /**
   * Records liveness, and optionally refreshes what the node reports about
   * itself.
   *
   * ⚠ A HEARTBEAT CANNOT CLEAR `disabled` OR `draining`. Those two are
   * OPERATOR state (see `WorkerNode.status` in `schema.prisma`): a human or
   * #270's lifecycle cron decided them, and they are decisions ABOUT the node
   * rather than facts reported BY it. A node whose heartbeat could set
   * `online` would walk out of its own kill switch on the next tick — five
   * seconds after an operator disabled it, with the operator watching the
   * fleet page show `online` and having no idea why. So the reported status
   * is applied only when the current status is one the node owns.
   *
   * `concurrency` IS applied, and applying it here is the entire mechanism
   * behind "a runtime `set-concurrency` takes effect on the next claim": the
   * claim endpoint re-reads this row rather than caching anything, so a
   * heartbeat is all it takes.
   */
  async heartbeat(
    userId: string,
    nodeId: string,
    dto: HeartbeatNodeDto
  ): Promise<WorkerNode> {
    const node = await this.assertOwnership(userId, nodeId);

    const operatorOwned =
      node.status === NodeStatus.disabled || node.status === NodeStatus.draining;

    if (dto.status && operatorOwned) {
      this.logger.debug(
        `Ignoring node ${node.id}'s self-reported status "${dto.status}": the row is ` +
          `"${node.status}", which only an operator may change.`
      );
    }

    return this.prisma.workerNode.update({
      where: { id: node.id },
      data: {
        lastHeartbeatAt: new Date(),
        ...(dto.status && !operatorOwned ? { status: dto.status as NodeStatus } : {}),
        ...(dto.concurrency === undefined ? {} : { concurrency: dto.concurrency }),
        ...(dto.capabilities === undefined
          ? {}
          : { capabilities: dto.capabilities as Prisma.InputJsonValue }),
      },
    });
  }

  // ===========================================================================
  // Reads
  // ===========================================================================

  /** Every node this user registered. */
  async listNodes(userId: string): Promise<WorkerNode[]> {
    return this.prisma.workerNode.findMany({
      where: { createdById: userId },
      orderBy: { name: 'asc' },
    });
  }

  /** One node, if it is this user's. */
  async getNode(userId: string, nodeId: string): Promise<WorkerNode> {
    return this.assertOwnership(userId, nodeId);
  }

  // ===========================================================================
  // Claiming
  // ===========================================================================

  /**
   * Takes up to the node's remaining capacity in runnable jobs, for the types
   * the node can actually run.
   *
   * THREE FILTERS, APPLIED IN THIS ORDER, and each one exists because of a
   * different way a fleet goes wrong:
   *
   *   1. WHAT THE NODE ASKED FOR, intersected with WHAT IT REGISTERED. A node
   *      can only ever NARROW, never widen: the request says which of its own
   *      types it currently has slots for, and anything it did not declare is
   *      dropped rather than honoured. Otherwise a node's claim request — the
   *      one input a compromised or misconfigured worker fully controls —
   *      would be enough to pull job types it was never approved for, and
   *      registration would stop meaning anything.
   *   2. WHAT A NODE CAN ACTUALLY RUN AT ALL: the types whose handler carries
   *      both `nodeResultSchema` and `persistNodeResult`. A node that claims a
   *      server-only type will compute something this server cannot store —
   *      its result post is refused as "not node-persistable", the row sits
   *      until its lease expires, the reaper requeues it, and the node claims
   *      it again. That is an infinite loop that burns an attempt per lap and
   *      looks, from the queue's side, like a job that keeps failing for no
   *      reason. Dropping the type here (with a warning naming it) makes the
   *      misconfiguration visible instead of expensive. REJECTED: letting the
   *      claim through and discovering it at result time, which is the same
   *      information one full lease later.
   *   3. THE CONCURRENCY CLAMP, read LIVE off the row. Never the value
   *      captured at registration, so `set-concurrency` through a heartbeat
   *      takes effect on the very next claim, and never the node's requested
   *      limit if it is larger — a node asking for more than it declared is
   *      describing slots it does not have.
   *
   * STATUS GATES BEFORE ANY OF THAT. `disabled` is 403: an operator has
   * switched this node off, the answer will not change by polling, and the
   * node should stop asking. `draining` is an EMPTY LIST rather than an
   * error, because draining is a normal state with a normal instruction —
   * "finish what you hold, take nothing new" — and a node that must keep
   * heartbeating and keep renewing leases while it drains must not be taught
   * that this endpoint is failing.
   *
   * `lastHeartbeatAt` IS NOT STAMPED HERE. Liveness has exactly one writer
   * (`heartbeat`), so "when did we last hear from this node" stays a question
   * about a column one route moves. A claim that also stamped it would let a
   * node that polls but never heartbeats look healthy on the fleet page
   * through a path that reports nothing about its health.
   */
  async claimJobs(userId: string, nodeId: string, dto: ClaimJobsDto): Promise<Job[]> {
    const node = await this.assertOwnership(userId, nodeId);

    if (node.status === NodeStatus.disabled) {
      throw new ForbiddenException({
        message:
          `Node ${node.id} is disabled and may not claim jobs. An operator disabled it; ` +
          `re-registering will not clear that.`,
        details: { nodeId: node.id, status: node.status },
      });
    }

    if (node.status === NodeStatus.draining) {
      this.logger.debug(`Node ${node.id} is draining; returning no jobs.`);
      return [];
    }

    const declared = new Set(node.eligibleTypes);
    const requested = dto.types?.length ? dto.types : node.eligibleTypes;
    const withinRegistration = requested.filter((type) => declared.has(type));

    const undeclared = requested.filter((type) => !declared.has(type));
    if (undeclared.length > 0) {
      this.logger.warn(
        `Node ${node.id} asked for type(s) it never registered: ` +
          `[${undeclared.join(', ')}]. Dropped — a node may narrow its registration, ` +
          `never widen it.`
      );
    }

    const nodeEligible = new Set(await this.nodeEligibleTypes());
    const eligibleTypes = withinRegistration.filter((type) => nodeEligible.has(type));

    const serverOnly = withinRegistration.filter((type) => !nodeEligible.has(type));
    if (serverOnly.length > 0) {
      this.logger.warn(
        `Node ${node.id} declared type(s) no node can run: [${serverOnly.join(', ')}]. ` +
          `Their handlers carry no nodeResultSchema/persistNodeResult pair, so this server ` +
          `could not store a result for them. Dropped from the claim.`
      );
    }

    const limit = Math.max(0, Math.min(dto.limit ?? node.concurrency, node.concurrency));

    return this.claims.claim({
      nodeId: node.id,
      executor: 'node',
      eligibleTypes,
      limit,
      // Derived on the server, identically to the in-process worker's — see
      // `resolveJobLeaseMs`, and the file header on why a node does not get
      // to choose its own lease.
      //
      // ONE PER TYPE, from the SAME intersected list passed as
      // `eligibleTypes` just above (#346). This is the claim that made
      // per-row leases necessary at all: a node takes up to its concurrency
      // ACROSS SEVERAL TYPES in one statement, so with per-type runtime
      // ceilings those rows do not share a lease. Built by the same
      // `buildClaimLeases` the in-process worker calls, so the fleet and the
      // server derive the identical lease for the identical type — the lease
      // is the reaper's contract, not a claimer's private detail.
      leases: buildClaimLeases(this.config, this.registry, eligibleTypes),
    });
  }

  /**
   * How often a node should renew the lease on a job of `type`, in
   * milliseconds — the server's answer, derived from the very lease the claim
   * granted.
   *
   * ⚠ THE SERVER DERIVES THIS, NOT THE NODE, for the same reason the server
   * derives the lease itself (see `claimJobs`): the renewal cadence and the
   * lease are one arithmetic relationship, and letting the two ends compute
   * their halves independently is how a node ends up renewing every 30 seconds
   * against a lease it was never told about — or, worse, less often than the
   * lease it holds, losing jobs it is actively running while doing everything
   * right. `resolveRenewIntervalMs` is the one derivation, and it is a third
   * of the lease so two consecutive missed renewals still cost nothing.
   *
   * The practical case that made this worth a wire field (#347): a type
   * declaring a six-hour `maxRuntimeMs` takes a six-hour lease, and the CLI's
   * shipped `DEFAULT_LEASE_RENEW_MS` of 30 seconds would spend 720 round trips
   * on it to no purpose whatsoever.
   *
   * ADDITIVE AND BACKWARD-COMPATIBLE on both ends: a node that ignores the
   * field keeps its own cadence and stays correct, and this method is total —
   * an unregistered type falls back through `resolveJobProfile`/
   * `resolveJobLeaseMs` to the deployment-wide lease exactly as the claim
   * would have.
   */
  renewIntervalMsFor(type: string): number {
    return resolveRenewIntervalMs(
      resolveJobLeaseMs(this.config, resolveJobProfile(this.registry.get(type)))
    );
  }

  /**
   * Extends the lease on a job this node is still legitimately holding.
   *
   * ⚠ THE WRITE RE-ASSERTS THE GUARD IN ITS OWN `WHERE` CLAUSE rather than
   * trusting the check that just passed. Between `assertJobHeldByNode`
   * reading the row and this statement running, the reaper can requeue the
   * job and another executor can claim it — the window is small and it is
   * real, and a renewal that landed inside it would extend a lease belonging
   * to somebody else, keeping the reaper away from a job the ORIGINAL node is
   * no longer running. `updateMany` with the ownership conditions makes the
   * check and the write the same statement; a zero count means the state
   * moved, which is a 409 exactly as a stale read would have been.
   *
   * ⚠ THAT GUARD NOW LIVES IN `JobLeaseService.heldLeaseWhere` (#347), NOT
   * HERE, and moving it there was the point of that issue rather than tidying.
   * The in-process worker renews too now, and "a lease that has already
   * expired may not be renewed, because another executor may own the row" is a
   * claim about the queue's invariants, not about this endpoint. Written twice
   * it drifts exactly once — somebody relaxes the expiry predicate on one side
   * to stop a flaky node losing jobs, and from then on that side can resurrect
   * a lease on a row the reaper has already given away. This is the same
   * argument `resolveJobLeaseMs` makes about deriving the lease: one function,
   * one rule, both executors.
   *
   * The 409 stays here, because it is the only part that is about HTTP: the
   * shared service answers `false`, and only a caller who has a remote client
   * waiting turns that into a status code.
   */
  async renewLease(
    userId: string,
    nodeId: string,
    jobId: string
  ): Promise<{ jobId: string; leaseExpiresAt: Date }> {
    const job = await this.assertJobHeldByNode(userId, nodeId, jobId);

    // The renewal grants the SAME lease the claim did, which means resolving
    // it from the same profile: a renewal computed from the deployment-wide
    // timeout would hand a six-hour type a ten-minute extension and have the
    // reaper take the job away from a node that is renewing on schedule.
    const leaseExpiresAt = new Date(
      Date.now() + resolveJobLeaseMs(this.config, resolveJobProfile(this.registry.get(job.type)))
    );

    // `renewUntil`, not `renew`: the instant written to the row has to be the
    // instant reported in the response, or the node schedules its next
    // renewal against a deadline the reaper does not read.
    const held = await this.leases.renewUntil(job.id, leaseExpiresAt, nodeId);

    if (!held) {
      throw this.notHeldByNode(jobId, nodeId);
    }

    return { jobId: job.id, leaseExpiresAt };
  }

  // ===========================================================================
  // Result ingestion
  // ===========================================================================

  /**
   * Accepts a node-computed result, validates it, persists it, and settles
   * the job.
   *
   * THE ORDER OF THE FIVE STEPS BELOW IS THE CONTRACT, and each step is a
   * different untrusted claim being checked before anything irreversible
   * happens. Nothing writes until the last two.
   *
   * WHY THE SCHEMA IS PARSED BY HAND HERE INSTEAD OF BY THE GLOBAL PIPE.
   * `nestjs-zod`'s pipe validates against a schema known at decoration time;
   * WHICH schema applies here is not known until the job row has been read
   * and its handler resolved, because it is the handler's `nodeResultSchema`.
   * There is no decorator that can express "the schema belonging to the type
   * of the row named in the path", so the parse happens where the information
   * exists — and its failure is converted into the same clean 400 the pipe
   * would have produced, with the issue list in `details` (the exception
   * filter rebuilds bodies from a fixed key allowlist, so a custom field has
   * nowhere else to go).
   *
   * ⚠ A `persistNodeResult` THROW BECOMES A JOB FAILURE, NOT AN API ERROR
   * THE NODE SHOULD RETRY. This is the subtlest decision in the file. Once
   * the server has begun persisting, it — not the node — owns the row's
   * lifecycle: the failure is routed through `completeFailed`, so it enters
   * the ordinary retry machine (backoff, attempt budget, eventual `failed`
   * with a readable `lastError`) exactly as an in-process handler's throw
   * would. The node is then told 500, which means "this is ours, not yours".
   * REJECTED: returning 4xx and letting the node resubmit. The job is no
   * longer `running` by then — `completeFailed` has already moved it — so
   * every resubmission would be refused by `assertJobHeldByNode` anyway, and
   * a node retrying a persist failure would hammer the endpoint while the
   * server's own retry was already scheduled. REJECTED equally: swallowing
   * the throw and returning success, which would leave a job marked
   * `succeeded` with nothing written.
   */
  async submitResult(
    userId: string,
    nodeId: string,
    jobId: string,
    dto: NodeJobResultDto
  ): Promise<NodeJobSettlement> {
    // 1. Is this job this node's to speak for, right now?
    const job = await this.assertJobHeldByNode(userId, nodeId, jobId);

    // 2. Is the node talking about the job it thinks it is talking about?
    if (dto.type !== job.type) {
      throw new BadRequestException({
        message:
          `This result declares type "${dto.type}" but job ${job.id} is of type ` +
          `"${job.type}". Nothing was persisted.`,
        details: { jobId: job.id, expectedType: job.type, receivedType: dto.type },
      });
    }

    // 3. Can this server store a node-computed result for this type at all?
    const handler = this.registry.get(job.type);
    const schema = handler?.nodeResultSchema;
    const persist = handler?.persistNodeResult;

    if (!handler || !schema || typeof persist !== 'function') {
      throw new BadRequestException({
        message:
          `Job type "${job.type}" is not node-persistable: its handler carries no ` +
          `nodeResultSchema/persistNodeResult pair, so this server cannot store a ` +
          `node-computed result for it.`,
        details: { jobId: job.id, type: job.type },
      });
    }

    // 4. Is the payload the shape that type promised? THE TRUST BOUNDARY.
    let parsed: unknown;

    try {
      parsed = schema.parse(dto.result);
    } catch (error) {
      throw new BadRequestException({
        message: `The result for job ${job.id} failed validation for type "${job.type}".`,
        details: { jobId: job.id, type: job.type, issues: describeValidationError(error) },
      });
    }

    // 5. Write it down — and if that throws, the job failed, not the request.
    try {
      await persist.call(handler, job, parsed);
    } catch (error) {
      const outcome = await this.terminal.completeFailed(job, error);

      this.logger.error(
        `Persisting node ${nodeId}'s result for job ${job.id} (${job.type}) threw; the job ` +
          `was settled as "${outcome}" through the normal failure path: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );

      throw new InternalServerErrorException({
        message:
          `The result for job ${job.id} could not be persisted. The job has been settled ` +
          `by this server; do not resubmit.`,
        details: { jobId: job.id, outcome, resubmit: false },
      });
    }

    const outcome = await this.terminal.completeSucceeded(job);

    return { jobId: job.id, outcome, willRetry: this.willRetry(outcome) };
  }

  /**
   * Records a failure a node reports for a job it is holding.
   *
   * A PASS-THROUGH BY DESIGN. The flags go straight into `completeFailed`,
   * which treats `rateLimited` identically to a `RateLimitError` thrown by an
   * in-process handler — down to tripping this server's own throttle gate, so
   * a node's 429 backs off sibling jobs running here too. This service
   * classifies nothing and decides nothing; see the file header on why both
   * executors must reach their conclusions through the same code.
   *
   * `willRetry` ARRIVES AND IS IGNORED. The response tells the node what the
   * server actually decided, which is the only version of that answer that
   * governs anything.
   */
  async reportFailure(
    userId: string,
    nodeId: string,
    jobId: string,
    dto: NodeJobFailureDto
  ): Promise<NodeJobSettlement> {
    const job = await this.assertJobHeldByNode(userId, nodeId, jobId);

    const outcome = await this.terminal.completeFailed(job, new Error(dto.error), {
      rateLimited: dto.rateLimited,
      retryAfterMs: dto.retryAfterMs,
    });

    this.logger.log(
      `Node ${nodeId} reported job ${job.id} (${job.type}) failed; settled as "${outcome}"` +
        `${dto.rateLimited ? ' (node reported a provider rate limit)' : ''}`
    );

    return { jobId: job.id, outcome, willRetry: this.willRetry(outcome) };
  }

  // ===========================================================================
  // The published contract
  // ===========================================================================

  /**
   * Every job type a node could run, each with the JSON Schema its results
   * must satisfy.
   *
   * THIS IS THE ONE PLACE THE RESULT CONTRACT CROSSES A PROCESS BOUNDARY, and
   * it does so as DATA rather than as a shared build artefact. A client — the
   * CLI is the first — validates a result before posting it, against the
   * schema this server will actually enforce in `submitResult`, generated from
   * the very same Zod object. There is no second definition to drift, no
   * package to publish, and no way for a client on an older release to
   * validate against a schema this server stopped using.
   *
   * REJECTED: a shared `packages/job-contracts` workspace exporting the Zod
   * schemas to every app. `packages/shared/index.js` already documents, at
   * length, why a compiled workspace package does not work in this
   * repository: `apps/api` builds with `rootDir: ./src`, so importing
   * TypeScript source from outside it widens the root and tsc starts emitting
   * `dist/src/main.js`, which no longer matches `start:prod`'s `node
   * dist/main` — a green build and a broken container. Its Jest config has no
   * `moduleNameMapper` and the default `transformIgnorePatterns`, so a
   * workspace symlink resolving to `.ts` would be untransformed and every API
   * suite would die at import time. And CI runs `npm ci` straight into
   * typecheck, so a package needing compilation would have to add a build step
   * to several jobs. `packages/shared` escapes all of that by shipping
   * committed `.js` plus a hand-written `.d.ts` — which is fine for a string
   * constant and useless for a Zod schema, whose entire value is the runtime
   * object.
   *
   * ⚠ `resultSchema` IS `null` RATHER THAN `{}` WHEN CONVERSION FAILS.
   * `z.toJSONSchema` throws on a schema with no JSON Schema representation (a
   * `z.custom()`, a `z.date()`, a transform), and the tempting rescue is to
   * publish an empty schema. That would be a LIE in the most expensive
   * direction: `{}` in JSON Schema means "anything is valid", so a client
   * would confidently validate garbage and be refused by the server it just
   * agreed with. `null` says "this one cannot be published — submit it and
   * let the server answer", which is true and actionable. The type is still
   * listed, because it is still claimable.
   */
  async listNodeEligibleJobTypes(): Promise<NodeEligibleJobType[]> {
    const types = await this.nodeEligibleTypes();

    return types.map((type) => ({
      type,
      label: jobTypeLabel(type),
      resultSchema: this.toPublishableSchema(type),
    }));
  }

  /**
   * `handler.nodeResultSchema` as JSON Schema, or `null` if it cannot be one.
   *
   * `io: 'input'` because what is being published is what a client must SEND.
   * The distinction is invisible for a plain object schema and real the moment
   * a schema grows a default or a coercion, where the input shape and the
   * parsed output shape stop agreeing — and publishing the output shape would
   * tell a client to send a field the server actually supplies for it.
   */
  private toPublishableSchema(type: string): Record<string, unknown> | null {
    const schema = this.registry.get(type)?.nodeResultSchema;

    if (!schema) {
      return null;
    }

    try {
      return z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
    } catch (error) {
      this.logger.warn(
        `Job type "${type}" is node-eligible but its nodeResultSchema has no JSON Schema ` +
          `representation, so clients cannot validate against it before submitting: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );

      return null;
    }
  }

  // ===========================================================================
  // The two shared guards
  // ===========================================================================

  /**
   * The node exists AND belongs to this caller — 404 for the first, 403 for
   * the second.
   *
   * ONE QUERY, and it RETURNS THE ROW. Both properties are deliberate: a
   * caller that had to fetch the node again after the check could act on a
   * different row than the one that was verified, and the second read would
   * be a second chance to forget the check entirely.
   *
   * See the file header for why this deliberately distinguishes "missing"
   * from "not yours" where `NodeCredentialService` deliberately does not.
   */
  async assertOwnership(userId: string, nodeId: string): Promise<WorkerNode> {
    const node = await this.prisma.workerNode.findUnique({ where: { id: nodeId } });

    if (!node) {
      throw new NotFoundException({
        message: `Worker node ${nodeId} was not found.`,
        details: { nodeId },
      });
    }

    if (node.createdById !== userId) {
      throw new ForbiddenException({
        message:
          `Worker node ${nodeId} belongs to another user. Check that this credential and ` +
          `this node id came from the same registration.`,
        details: { nodeId },
      });
    }

    return node;
  }

  /**
   * The job is claimed by THIS node, is `running`, and its lease has not
   * expired — otherwise 409.
   *
   * THE FOUR CONDITIONS ARE ONE CONDITION, checked together and reported
   * together. Splitting them into distinct errors would tell a remote caller
   * which of "wrong node", "already finished" and "lease expired" applied,
   * which is information about another executor's progress that a node has no
   * use for and cannot act on differently — its correct response is the same
   * in all three cases: drop the work.
   *
   * See the file header for the late-submission scenario this prevents, and
   * for why the answer is 409 rather than 400.
   */
  async assertJobHeldByNode(userId: string, nodeId: string, jobId: string): Promise<Job> {
    // Ownership first: a caller who does not own the node must not learn
    // anything about the jobs it holds, including whether a job id exists.
    await this.assertOwnership(userId, nodeId);

    const job = await this.prisma.job.findUnique({ where: { id: jobId } });

    if (!job) {
      throw new NotFoundException({
        message: `Job ${jobId} was not found.`,
        details: { jobId },
      });
    }

    if (
      job.claimedByNodeId !== nodeId ||
      job.status !== 'running' ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt <= new Date()
    ) {
      throw this.notHeldByNode(jobId, nodeId);
    }

    return job;
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  /**
   * The one 409 body, built in one place.
   *
   * Two call sites raise it — the read guard and the renewal's re-assertion —
   * and they are answering the identical question, so a second hand-written
   * message is a second chance for the two to describe the same state
   * differently.
   */
  private notHeldByNode(jobId: string, nodeId: string): ConflictException {
    return new ConflictException({
      message:
        `Job ${jobId} is not held by node ${nodeId} with a live lease. It was reassigned, ` +
        `already settled, or its lease expired and another executor may now own it. Drop ` +
        `this work; do not retry.`,
      details: { jobId, nodeId, reason: 'lease_not_held' },
    });
  }

  /** `(createdById, name)` — the register-or-reattach anchor. */
  private findByName(userId: string, name: string): Promise<WorkerNode | null> {
    return this.prisma.workerNode.findUnique({
      where: { createdById_name: { createdById: userId, name } },
    });
  }

  /**
   * The registered types a node may claim in THIS deployment, right now.
   *
   * ⚠ DELEGATED, AND THE DELEGATION IS THE POINT (#352). This used to be
   * derived here, and `JobWorker`'s `system` mode derived the OPPOSITE answer
   * from `registry.serverOnlyTypes()` — two independent derivations of one
   * question, which agreed only for as long as node eligibility was a purely
   * static property of a handler. The moment a type's eligibility acquired
   * runtime gates (a settings switch, a capability probe), the two answers
   * diverged and `db.backup.run` fell into the gap: no node was allowed to
   * claim it and the `system` worker no longer claimed it either, so on such a
   * deployment NOBODY TOOK THE BACKUPS.
   *
   * `NodeOffloadService` is now the one function, and the two executors read
   * it in opposite directions — this one takes the set, the worker takes its
   * complement — so they partition the queue by construction. Its header
   * carries the full argument, including why it lives in `jobs/` rather than
   * here (the nodes module imports the jobs module; the reverse would be a
   * cycle).
   */
  private nodeEligibleTypes(): Promise<string[]> {
    return this.offload.offeredTypes();
  }

  /** Whether a settled outcome means the job is coming back. */
  private willRetry(outcome: JobSettleOutcome): boolean {
    return outcome === 'retry-scheduled' || outcome === 'rate-limit-deferred';
  }
}

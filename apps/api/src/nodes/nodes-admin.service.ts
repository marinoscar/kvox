// =============================================================================
// The admin fleet plane (issue #270, epic #254)
// =============================================================================
//
// `NodesService` answers questions a NODE asks about ITSELF, scoped by
// `assertOwnership`: a `nod_` credential resolves to one user, and that user's
// nodes are the only rows it may ever see or change. This service answers the
// questions an ADMINISTRATOR asks about the WHOLE DEPLOYMENT, and the
// difference is not a parameter — it is the absence of the ownership check
// that every method in the other service begins with.
//
// That is why this is a separate service and not four more methods on
// `NodesService`. Concretely:
//
//   - Every method there takes `userId` FIRST and passes it to
//     `assertOwnership` before touching anything. A cross-owner method sitting
//     among them would be the one method whose first parameter is not a
//     scope, and the day somebody copies the method above it as a template,
//     the copy inherits the wrong shape.
//   - `NodesModule` does not export `NodesService`, on the grounds that a
//     feature module able to inject it could claim jobs on a node's behalf.
//     The same rule applies here, and this service additionally has NO OWNER
//     SCOPE AT ALL: it is provided to exactly one controller, which is gated
//     on the Admin role and the `nodes:*` permissions.
//
// -----------------------------------------------------------------------------
// ONE `groupBy` FOR THE WHOLE FLEET, NEVER A COUNT PER NODE
// -----------------------------------------------------------------------------
//
// The fleet page POLLS. Per-node job counts written the obvious way — a
// `count` inside the `map` over nodes — is N+1 queries per poll, per open
// browser tab, forever, and it degrades exactly when it matters most (a
// growing fleet, an operator watching an incident with the page open). It also
// degrades INVISIBLY: with three nodes on a laptop it is indistinguishable
// from the right answer.
//
// So the counts come from ONE `groupBy(['claimedByNodeId', 'status'])` whose
// cost does not depend on the size of the fleet, and
// `nodes-admin.service.spec.ts` asserts the call COUNT rather than only the
// result — because the result is identical either way, and an assertion on the
// result alone would let the N+1 back in on the next refactor.
//
// REJECTED: a denormalised counter column on `worker_nodes`. It has to be kept
// correct by every write path that touches a job (claim, settle, reap, purge,
// admin retry, admin delete), and the first one that forgets leaves a number
// that is wrong forever with nothing to reconcile it against. A `groupBy` is
// derived from the rows themselves and cannot drift.
//
// -----------------------------------------------------------------------------
// HEALTH IS DERIVED HERE, BY THE SHARED FUNCTION, ON BOTH PATHS
// -----------------------------------------------------------------------------
//
// `deriveNodeHealth` (see `node-lifecycle.service.ts`) is called by the list
// AND by the detail read, from the same policy, so the two cannot disagree —
// the failure being avoided is a fleet page showing a "stale" pill next to a
// detail panel that says the node is fine, which teaches an operator to
// distrust both. It is a pure function of the row and the clock; there is no
// `health` column and there must not be one.
// =============================================================================

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { WorkerNode } from '@prisma/client';

import { AdminNodeCredentialDto, AdminNodeDto, NodeJobCountsDto } from './dto/node-admin.dto';
import { deriveNodeHealth, NodeLifecycleService } from './node-lifecycle.service';
import { NodeCredentialService } from './node-credential.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The owner columns every admin response carries, selected explicitly.
 *
 * The column on `User` is `displayName`; the wire field is `owner.name`. The
 * two names are deliberately different and `toAdminNodeDto` maps between them
 * — selecting `name` here is not a fix, it is a Prisma validation error.
 *
 * Exported (not module-private) so
 * `test/nodes/worker-node-model-fields.spec.ts` can assert its keys are real
 * `User` scalar columns without duplicating this literal — issue #340 was
 * exactly this select naming a column, `name`, that does not exist, and every
 * existing test mocked `PrismaService` so nothing caught it.
 */
export const OWNER_SELECT = { select: { id: true, email: true, displayName: true } } as const;

/** A node row with its owner joined — what both read paths load. */
type NodeWithOwner = WorkerNode & {
  createdBy: { id: string; email: string; displayName: string | null };
};

@Injectable()
export class NodesAdminService {
  private readonly logger = new Logger(NodesAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: NodeLifecycleService,
    private readonly credentials: NodeCredentialService
  ) {}

  // ===========================================================================
  // Reads
  // ===========================================================================

  /**
   * Every node in the deployment, with derived health and job counts.
   *
   * THREE QUERIES, AND THE NUMBER DOES NOT DEPEND ON THE FLEET SIZE: the
   * nodes, the settings row behind the stale window, and one `groupBy` for
   * every node's counts at once. See the file header.
   *
   * Ordered by name, matching `NodesService.listNodes`, so a node keeps the
   * same position in the admin table and the owner's own list.
   *
   * Not paginated, for the reason `listCredentials` gives: a fleet is bounded
   * by machines an operator physically runs, and a page cursor over a list
   * somebody is scanning for the one red row hides that row on page two.
   */
  async listFleet(): Promise<AdminNodeDto[]> {
    const [nodes, policy, counts] = await Promise.all([
      this.prisma.workerNode.findMany({
        orderBy: { name: 'asc' },
        include: { createdBy: OWNER_SELECT },
      }),
      this.lifecycle.getPolicy(),
      this.jobCountsByNode(),
    ]);

    const now = new Date();

    return (nodes as NodeWithOwner[]).map((node) =>
      this.toAdminNodeDto(node, policy.staleHeartbeatSeconds, counts.get(node.id), now)
    );
  }

  /**
   * One node, whoever owns it.
   *
   * The detail half of the pair, and it exists so `deriveNodeHealth` has TWO
   * callers rather than one: a single caller is a function that has not yet
   * been proven shared, and the next surface that needs a verdict is the one
   * that writes its own. It is also the natural place an admin lands from a
   * row in the fleet table.
   *
   * `404` when there is no such node — never a `403`, because an
   * administrator's scope is the deployment and there is no other user's row
   * for them to be refused.
   */
  async getNode(nodeId: string): Promise<AdminNodeDto> {
    const [node, policy, counts] = await Promise.all([
      this.prisma.workerNode.findUnique({
        where: { id: nodeId },
        include: { createdBy: OWNER_SELECT },
      }),
      this.lifecycle.getPolicy(),
      this.jobCountsByNode(nodeId),
    ]);

    if (!node) {
      throw new NotFoundException({
        message: `Worker node ${nodeId} was not found.`,
        details: { nodeId },
      });
    }

    return this.toAdminNodeDto(
      node as NodeWithOwner,
      policy.staleHeartbeatSeconds,
      counts.get(nodeId),
      new Date()
    );
  }

  /** Every node credential in the deployment, masked, with its owner. */
  async listCredentials(): Promise<AdminNodeCredentialDto[]> {
    const rows = await this.credentials.listAllCredentials();

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      tokenPrefix: row.tokenPrefix,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      owner: { id: row.user.id, email: row.user.email, name: row.user.displayName },
    }));
  }

  // ===========================================================================
  // Writes
  // ===========================================================================

  /**
   * Removes a node record, whoever owns it.
   *
   * ⚠ THIS IS ALLOWED EVEN WHILE THE NODE HOLDS `running` JOBS, which is the
   * opposite of what `NodeOfflinePruneTask` does, and the difference is
   * intent. The prune is a TIMER acting on a guess about a machine nobody has
   * looked at; when it is wrong it destroys a registration silently, so it
   * declines the ambiguous case. This is an ADMINISTRATOR who has looked and
   * decided — most often at a node they know is never coming back, which is
   * precisely the node whose jobs are stuck and which they are deleting in
   * order to unstick them. Refusing here would make the tool useless in the
   * only situation anybody reaches for it.
   *
   * Held jobs are NOT deleted and NOT requeued here. `Job.claimedByNode` is
   * `onDelete: SetNull`, so their claim pointer is nulled and the rows stay
   * exactly as they were — still `running`, still carrying their lease. The
   * lease reaper then finds them by the signal it already has (an expired
   * lease belonging to nobody) and requeues or fails them on the normal
   * budget. REJECTED: requeueing them here. It would be a second, hand-written
   * copy of the reaper's two-phase decision — including the attempt-budget
   * give-up — living in an admin service, and the first divergence between the
   * two is a poison-pill job that becomes eternal when an admin deletes its
   * node.
   */
  async deleteNode(nodeId: string): Promise<void> {
    const node = await this.prisma.workerNode.findUnique({
      where: { id: nodeId },
      select: { id: true, name: true, status: true, createdById: true },
    });

    if (!node) {
      throw new NotFoundException({
        message: `Worker node ${nodeId} was not found.`,
        details: { nodeId },
      });
    }

    await this.prisma.workerNode.delete({ where: { id: node.id } });

    this.logger.log(
      `Deleted worker node "${node.name}" (${node.id}, status ${node.status}) owned by ` +
        `${node.createdById}. Any jobs it held keep their rows with claimedByNodeId cleared; ` +
        `the lease reaper settles them.`
    );
  }

  /** Revokes any node credential, whoever owns it. */
  async revokeCredential(credentialId: string): Promise<void> {
    await this.credentials.revokeAnyCredential(credentialId);
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  /**
   * Job counts for every node at once, as `nodeId -> counts`.
   *
   * ONE `groupBy`, whatever the fleet size — the whole point of the file
   * header. `nodeId` narrows it to a single node for the detail read; the
   * shape of the query is identical either way, so the list and the detail
   * cannot end up counting differently.
   *
   * `claimedByNodeId: { not: null }` keeps the server's own in-process jobs
   * out of the grouping: they are the majority of rows in a single-server
   * deployment and belong to no node.
   */
  private async jobCountsByNode(nodeId?: string): Promise<Map<string, NodeJobCountsDto>> {
    const grouped = await this.prisma.job.groupBy({
      by: ['claimedByNodeId', 'status'],
      where: { claimedByNodeId: nodeId ? nodeId : { not: null } },
      _count: { _all: true },
    });

    const counts = new Map<string, NodeJobCountsDto>();

    for (const row of grouped) {
      if (!row.claimedByNodeId) {
        continue;
      }

      const entry = counts.get(row.claimedByNodeId) ?? emptyCounts();
      const amount = row._count?._all ?? 0;

      if (row.status in entry) {
        (entry as unknown as Record<string, number>)[row.status] += amount;
      }
      entry.total += amount;

      counts.set(row.claimedByNodeId, entry);
    }

    return counts;
  }

  /** A row plus its derived verdict and counts, as the wire shape. */
  private toAdminNodeDto(
    node: NodeWithOwner,
    staleHeartbeatSeconds: number,
    counts: NodeJobCountsDto | undefined,
    now: Date
  ): AdminNodeDto {
    return {
      id: node.id,
      name: node.name,
      hostname: node.hostname,
      platform: node.platform,
      cliVersion: node.cliVersion,
      eligibleTypes: node.eligibleTypes,
      concurrency: node.concurrency,
      status: node.status,
      health: deriveNodeHealth(node, staleHeartbeatSeconds, now),
      capabilities: node.capabilities ?? null,
      registeredAt: node.registeredAt.toISOString(),
      lastHeartbeatAt: node.lastHeartbeatAt ? node.lastHeartbeatAt.toISOString() : null,
      owner: {
        id: node.createdBy.id,
        email: node.createdBy.email,
        name: node.createdBy.displayName,
      },
      // A node with no jobs at all produces no `groupBy` row, which is
      // "absent", not "zero" — the map lookup misses and the zeroes are
      // supplied here. See `NodeJobCountsDto` for why the keys are never
      // sparse on the wire.
      jobCounts: counts ?? emptyCounts(),
    };
  }
}

/** Four zeroes and a total, for a node the grouping produced no row for. */
function emptyCounts(): NodeJobCountsDto {
  return { running: 0, pending: 0, succeeded: 0, failed: 0, total: 0 };
}

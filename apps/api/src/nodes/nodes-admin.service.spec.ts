// =============================================================================
// Unit tests for the admin fleet plane (issue #270, epic #254)
// =============================================================================
//
// Two of these are load-bearing beyond their own assertion:
//
//   1. THE COUNT OF QUERIES, not just their result. Per-node job counts
//      written the obvious way — a `count` inside the `map` over nodes —
//      returns the RIGHT ANSWER while being N+1 queries per poll of a page
//      that polls. An assertion on the result alone cannot tell the two
//      implementations apart, so the assertion is on `groupBy` being called
//      once and on `count` never being called at all.
//
//   2. THE LIST AND THE DETAIL AGREE. Both go through `deriveNodeHealth` with
//      the same policy; the failure being prevented is a fleet page showing a
//      "stale" pill beside a detail panel that says the node is fine, which
//      teaches an operator to distrust both.
// =============================================================================

import { NotFoundException } from '@nestjs/common';

import { NodesAdminService } from './nodes-admin.service';
import type { NodeCredentialService } from './node-credential.service';
import type { NodeLifecycleService } from './node-lifecycle.service';
import type { PrismaService } from '../prisma/prisma.service';

const POLICY = { staleHeartbeatSeconds: 90, offlineStaleMultiplier: 4, offlineRetentionDays: 30 };

// The wire shape (`owner.name`) and what Prisma actually returns for
// `OWNER_SELECT`/`CREDENTIAL_OWNER_SELECT` (`displayName`) are deliberately
// different — see the comment on `OWNER_SELECT` in `nodes-admin.service.ts`.
// Issue #340 was these two rows silently matching each other because the
// select used to (wrongly) ask for `name` too; keeping them as two separate
// constants here is what makes that particular bug reappear as a failing
// assertion instead of a fixture that quietly agrees with broken code.
const OWNER_ROW = { id: 'owner-1', email: 'ops@example.test', displayName: 'Ops' };
const OWNER = { id: 'owner-1', email: 'ops@example.test', name: 'Ops' };

function nodeRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    hostname: `${id}-box`,
    platform: 'linux-x64',
    cliVersion: '1.2.3',
    eligibleTypes: ['example.checksum'],
    concurrency: 2,
    status: 'online',
    capabilities: null,
    registeredAt: new Date('2026-01-01T00:00:00.000Z'),
    lastHeartbeatAt: new Date(Date.now() - 10_000),
    createdById: OWNER_ROW.id,
    createdBy: OWNER_ROW,
    ...overrides,
  };
}

function makeService(nodes: ReturnType<typeof nodeRow>[], grouped: unknown[] = []) {
  const prisma = {
    workerNode: {
      findMany: jest.fn().mockResolvedValue(nodes),
      findUnique: jest.fn().mockResolvedValue(nodes[0] ?? null),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    job: {
      groupBy: jest.fn().mockResolvedValue(grouped),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaService;

  const lifecycle = { getPolicy: jest.fn().mockResolvedValue(POLICY) } as unknown as NodeLifecycleService;

  const credentials = {
    listAllCredentials: jest.fn().mockResolvedValue([]),
    revokeAnyCredential: jest.fn().mockResolvedValue(undefined),
  } as unknown as NodeCredentialService;

  return { service: new NodesAdminService(prisma, lifecycle, credentials), prisma, credentials };
}

describe('NodesAdminService', () => {
  describe('listFleet', () => {
    it('counts jobs for the whole fleet with ONE groupBy, never a query per node', async () => {
      const { service, prisma } = makeService([nodeRow('a'), nodeRow('b'), nodeRow('c')]);

      await service.listFleet();

      expect((prisma.job.groupBy as jest.Mock)).toHaveBeenCalledTimes(1);
      // The N+1 this file exists to prevent returns the identical result, so
      // the absence of the per-node call is the assertion that catches it.
      expect((prisma.job.count as jest.Mock)).not.toHaveBeenCalled();
      expect((prisma.job.groupBy as jest.Mock).mock.calls[0][0]).toMatchObject({
        by: ['claimedByNodeId', 'status'],
        where: { claimedByNodeId: { not: null } },
      });
    });

    it('folds the grouped rows into per-node counts with a total', async () => {
      const { service } = makeService(
        [nodeRow('a'), nodeRow('b')],
        [
          { claimedByNodeId: 'a', status: 'running', _count: { _all: 2 } },
          { claimedByNodeId: 'a', status: 'succeeded', _count: { _all: 7 } },
          { claimedByNodeId: 'b', status: 'failed', _count: { _all: 1 } },
        ]
      );

      const fleet = await service.listFleet();

      expect(fleet[0].jobCounts).toEqual({
        running: 2,
        pending: 0,
        succeeded: 7,
        failed: 0,
        total: 9,
      });
      expect(fleet[1].jobCounts).toEqual({
        running: 0,
        pending: 0,
        succeeded: 0,
        failed: 1,
        total: 1,
      });
    });

    it('reports zeroes rather than absent keys for a node that has run nothing', async () => {
      // A sparse map would make the fleet page write `counts.running ?? 0` at
      // every use, and the first place somebody forgot would render an empty
      // cell — indistinguishable from a count that failed to load.
      const { service } = makeService([nodeRow('idle')]);

      expect((await service.listFleet())[0].jobCounts).toEqual({
        running: 0,
        pending: 0,
        succeeded: 0,
        failed: 0,
        total: 0,
      });
    });

    it('derives health from the heartbeat and carries the owner', async () => {
      const { service } = makeService([
        nodeRow('fresh'),
        nodeRow('silent', { lastHeartbeatAt: new Date(Date.now() - 3_600_000) }),
        nodeRow('gone', { status: 'offline' }),
        nodeRow('never', { lastHeartbeatAt: null }),
      ]);

      const fleet = await service.listFleet();

      expect(fleet.map((node) => node.health)).toEqual(['healthy', 'stale', 'offline', 'stale']);
      expect(fleet[0].owner).toEqual(OWNER);
    });
  });

  describe('getNode', () => {
    it('derives health with the same function the list uses', async () => {
      const silent = nodeRow('silent', { lastHeartbeatAt: new Date(Date.now() - 3_600_000) });
      const { service } = makeService([silent]);

      const [fromList, fromDetail] = [await service.listFleet(), await service.getNode('silent')];

      expect(fromDetail.health).toBe('stale');
      expect(fromList[0].health).toBe(fromDetail.health);
    });

    it('scopes the grouping to the one node', async () => {
      const { service, prisma } = makeService([nodeRow('one')]);

      await service.getNode('one');

      expect((prisma.job.groupBy as jest.Mock).mock.calls[0][0].where).toEqual({
        claimedByNodeId: 'one',
      });
    });

    it('404s for a node that does not exist — never 403, an admin has no other scope', async () => {
      const { service, prisma } = makeService([]);
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.getNode('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('deleteNode', () => {
    it('deletes the node row and nothing else — jobs are left to the reaper', async () => {
      // `Job.claimedByNode` is `onDelete: SetNull`, so held jobs keep their
      // rows with the claim pointer cleared. Requeueing them here would be a
      // second, hand-written copy of the reaper's two-phase decision.
      const { service, prisma } = makeService([nodeRow('doomed')]);

      await service.deleteNode('doomed');

      expect((prisma.workerNode.delete as jest.Mock)).toHaveBeenCalledWith({
        where: { id: 'doomed' },
      });
      expect((prisma.job.findMany as jest.Mock)).not.toHaveBeenCalled();
    });

    it('deletes a node that is still holding running jobs', async () => {
      // The opposite of what the PRUNE does, and deliberately: an
      // administrator deleting a node has looked at it, and it is usually the
      // node that is never coming back and whose jobs they want unstuck.
      const { service, prisma } = makeService([nodeRow('crashed', { status: 'offline' })]);

      await service.deleteNode('crashed');

      expect((prisma.workerNode.delete as jest.Mock)).toHaveBeenCalledTimes(1);
    });

    it('404s for a node that does not exist', async () => {
      const { service, prisma } = makeService([]);
      (prisma.workerNode.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.deleteNode('missing')).rejects.toBeInstanceOf(NotFoundException);
      expect((prisma.workerNode.delete as jest.Mock)).not.toHaveBeenCalled();
    });
  });

  describe('credentials', () => {
    it('revokes through the one revocation path rather than writing its own', async () => {
      const { service, credentials } = makeService([]);

      await service.revokeCredential('cred-1');

      expect(credentials.revokeAnyCredential).toHaveBeenCalledWith('cred-1');
    });

    it('renders owners and never a token or a hash', async () => {
      const { service, credentials } = makeService([]);
      (credentials.listAllCredentials as jest.Mock).mockResolvedValue([
        {
          id: 'cred-1',
          name: 'gpu-box',
          tokenPrefix: 'nod_1a2b',
          expiresAt: null,
          lastUsedAt: new Date('2026-03-01T00:00:00.000Z'),
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          revokedAt: null,
          user: OWNER_ROW,
        },
      ]);

      const [credential] = await service.listCredentials();

      expect(credential).toEqual({
        id: 'cred-1',
        name: 'gpu-box',
        tokenPrefix: 'nod_1a2b',
        expiresAt: null,
        lastUsedAt: '2026-03-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        revokedAt: null,
        owner: OWNER,
      });
      expect(Object.keys(credential)).not.toContain('token');
      expect(Object.keys(credential)).not.toContain('tokenHash');
    });
  });
});

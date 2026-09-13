import { z } from 'zod';

import { JobHandlerRegistry } from './job-handler.registry';
import { NodeOffloadService, readJobSecretBrokerEnabled } from './node-offload.service';
import type { JobSecretBroker } from './job-secret-broker';
import type { SystemSettingsService } from '../settings/system-settings/system-settings.service';

// =============================================================================
// NodeOffloadService (issue #352, epic #345)
// =============================================================================
//
// ONE FUNCTION, TWO READERS, AND THE PROPERTY IS THE PARTITION. The node plane
// takes `offeredTypes()`; `JobWorker`'s `system` mode takes
// `serverOnlyRightNow()`. Every case below is really about one of two failures:
//
//   * A HOLE — a type in neither set, claimed by nobody. That is what happened
//     when the two sides derived their answers independently and a runtime
//     gate appeared: `db.backup.run` left `serverOnlyTypes()` structurally
//     while its gates kept every node away from it, and the deployment
//     silently stopped taking backups.
//   * A GATE THAT FAILS THE WRONG WAY — a settings read or a capability probe
//     that throws must withhold ONE type from nodes (and therefore hand it to
//     the server), never fail a claim and never open a trust boundary.
//
// The registry here is the real one; only the settings read and the brokers
// are doubles, because those are the two things that reach outside the process.
// =============================================================================

describe('NodeOffloadService', () => {
  let registry: JobHandlerRegistry;
  let getNodesPolicy: jest.Mock;
  let service: NodeOffloadService;

  /** A handler with the two members that make a type node-eligible. */
  const nodeEligible = (type: string, extra: Record<string, unknown> = {}) => ({
    type,
    process: async () => undefined,
    nodeResultSchema: z.object({ ok: z.boolean() }),
    persistNodeResult: async () => undefined,
    ...extra,
  });

  const broker = (overrides: Partial<JobSecretBroker> = {}): JobSecretBroker =>
    ({
      kind: 'test.postgres',
      usable: jest.fn().mockResolvedValue({ ok: true }),
      issue: jest.fn(),
      revoke: jest.fn(),
      ...overrides,
    }) as JobSecretBroker;

  beforeEach(() => {
    registry = new JobHandlerRegistry();
    getNodesPolicy = jest.fn().mockResolvedValue({ jobSecretBrokerEnabled: true });
    service = new NodeOffloadService(registry, {
      getNodesPolicy,
    } as unknown as SystemSettingsService);

    registry.register({ type: 'test.server-only', process: async () => undefined });
    registry.register(nodeEligible('test.open'));
  });

  describe('offeredTypes', () => {
    it('offers a plain node-eligible type and never a server-only one', async () => {
      await expect(service.offeredTypes()).resolves.toEqual(['test.open']);
    });

    it('withholds a broker-carrying type while `nodes.jobSecretBrokerEnabled` is off', async () => {
      getNodesPolicy.mockResolvedValue({ jobSecretBrokerEnabled: false });
      registry.register(nodeEligible('test.needs-credential', { nodeSecretBroker: broker() }));

      await expect(service.offeredTypes()).resolves.toEqual(['test.open']);
      // ⚠ AND THE REGISTRY IS UNTOUCHED. The type is still node-eligible; this
      // deployment declines to offer it. A mutation here would make "can this
      // type run on a node" depend on a setting, which is the disagreement
      // `job-handler.interface.ts` makes unrepresentable.
      expect(registry.serverOnlyTypes()).not.toContain('test.needs-credential');
    });

    it('withholds a type whose broker says it cannot mint here', async () => {
      registry.register(
        nodeEligible('test.needs-credential', {
          nodeSecretBroker: broker({
            usable: jest
              .fn()
              .mockResolvedValue({ ok: false, reason: 'no CREATEROLE', remedy: 'GRANT it' }),
          }),
        })
      );

      await expect(service.offeredTypes()).resolves.toEqual(['test.open']);
    });

    it('withholds a type whose deployment gate says no, and asks it EVERY call', async () => {
      const gate = jest.fn().mockResolvedValue(false);
      registry.register(nodeEligible('test.gated', { nodeOffloadEnabled: gate }));

      await expect(service.offeredTypes()).resolves.toEqual(['test.open']);
      await service.offeredTypes();

      // Not cached: a cache is how "we turned offload off" takes effect at
      // some unspecified later time.
      expect(gate).toHaveBeenCalledTimes(2);
    });

    it('probes the broker LAST — a deployment that said no never opens a connection', async () => {
      const usable = jest.fn().mockResolvedValue({ ok: true });
      registry.register(
        nodeEligible('test.gated-with-broker', {
          nodeSecretBroker: broker({ usable }),
          nodeOffloadEnabled: async () => false,
        })
      );

      await service.offeredTypes();

      expect(usable).not.toHaveBeenCalled();
    });

    it('withholds ONLY the affected type when a probe or a gate throws', async () => {
      registry.register(
        nodeEligible('test.probe-throws', {
          nodeSecretBroker: broker({ usable: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) }),
        })
      );
      registry.register(
        nodeEligible('test.gate-throws', {
          nodeOffloadEnabled: jest.fn().mockRejectedValue(new Error('settings unreadable')),
        })
      );

      // A claim that failed would drop unrelated work the node is holding.
      await expect(service.offeredTypes()).resolves.toEqual(['test.open']);
    });

    it('FAILS CLOSED when the settings read throws — no credential, and the server keeps the work', async () => {
      getNodesPolicy.mockRejectedValue(new Error('settings row unreadable'));
      registry.register(nodeEligible('test.needs-credential', { nodeSecretBroker: broker() }));

      await expect(service.offeredTypes()).resolves.toEqual(['test.open']);
      // The other half of "fail closed": the type is not lost, it is claimed
      // by this process instead.
      await expect(service.serverOnlyRightNow()).resolves.toContain('test.needs-credential');
    });
  });

  describe('serverOnlyRightNow — the complement `system` mode claims', () => {
    it('is exactly the registry minus what a node is offered', async () => {
      registry.register(nodeEligible('test.gated', { nodeOffloadEnabled: async () => false }));

      const offered = await service.offeredTypes();
      const server = await service.serverOnlyRightNow();

      // ⚠ THE PROPERTY, STATED AS A PROPERTY: disjoint, and together the whole
      // registry. Two independent derivations can satisfy either half alone.
      expect(server.filter((type) => offered.includes(type))).toEqual([]);
      expect([...offered, ...server].sort()).toEqual(registry.types().sort());
    });

    it('includes a node-eligible type whose gates are shut — the hole this service closed', async () => {
      registry.register(nodeEligible('test.gated', { nodeOffloadEnabled: async () => false }));

      // `serverOnlyTypes()` — the STATIC answer `system` mode used to read —
      // does not contain it, which is exactly how it came to be claimed by
      // nobody at all.
      expect(registry.serverOnlyTypes()).not.toContain('test.gated');
      await expect(service.serverOnlyRightNow()).resolves.toContain('test.gated');
    });

    it('drops it again the moment the deployment opens the gate', async () => {
      let enabled = false;
      registry.register(nodeEligible('test.gated', { nodeOffloadEnabled: async () => enabled }));

      await expect(service.serverOnlyRightNow()).resolves.toContain('test.gated');

      enabled = true;

      await expect(service.serverOnlyRightNow()).resolves.not.toContain('test.gated');
      await expect(service.offeredTypes()).resolves.toContain('test.gated');
    });
  });

  describe('readJobSecretBrokerEnabled', () => {
    it.each([
      ['a missing key', {}],
      ['the string "true"', { jobSecretBrokerEnabled: 'true' }],
      ['the number 1', { jobSecretBrokerEnabled: 1 }],
      ['null', { jobSecretBrokerEnabled: null }],
      ['an unreadable policy', null],
    ])('is false for %s', (_label, policy) => {
      expect(readJobSecretBrokerEnabled(policy as never)).toBe(false);
    });

    it('is true only for a literal `true`', () => {
      expect(readJobSecretBrokerEnabled({ jobSecretBrokerEnabled: true })).toBe(true);
    });
  });
});

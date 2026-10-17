// =============================================================================
// Test helper: the ports the graph slices run on, over a bare Prisma client (issue #496, epic #491)
// =============================================================================
//
// `@marinoscar/kvox-api/graph`, `/graph-extraction` and `/graph-rdf` reach the queue, the object store,
// the audit trail, the settings and the identity rules through ports. The real-Postgres suites build
// the services by hand over a plain `PrismaClient`; this binds each port the way the web edition does
// where that is cheap (the real object-store adapter over the real ownership table, the real jobs
// adapter over the real queue, an audit port that writes the same `audit_events` rows the platform
// sink does) and reads the two settings the graph asks for straight from the same tables the platform
// settings service stores them in. Nothing here is a fake of the behaviour a spec asserts on.
// =============================================================================

import { EventEmitter2 } from '@nestjs/event-emitter';
import type { PrismaClient } from '@prisma/client';
import { GraphObjectsService } from '@marinoscar/kvox-api/graph';
import type { KvoxIdentityPort, KvoxJobsPort, KvoxSettingsPort } from '@marinoscar/kvox-api/ports';
import { createInMemoryKvoxEvents } from '@marinoscar/kvox-api/testing';
import { JobHandlerRegistry, JobsService, ProviderThrottleService } from '@marinoscar/platform-api/jobs';

import { PlatformKvoxJobsAdapter } from '../../src/platform-kvox/jobs/platform-kvox-jobs.adapter';
import { asPrismaService, createDbAudit, createDbObjectStore, UNUSED_STORAGE } from './db-managed-objects.helper';

export { createDbAudit };

/**
 * The two settings reads the graph makes (`ai` system namespace, `graph` user namespace) over the stored rows.
 * `overrides` are laid over the stored value of a system namespace: the specs run the graph with its
 * deployment switch on (`ai.graphEnabled`) whatever the seeded settings row says.
 */
export function createDbSettings(
  client: PrismaClient,
  overrides: Record<string, unknown> = { ai: { graphEnabled: true } },
): KvoxSettingsPort {
  return {
    registerNamespace: () => undefined,
    readSystem: async <T>(name: string) => {
      const row = await client.systemSettings.findUnique({ where: { key: 'global' } });
      const stored = (row?.value as Record<string, unknown> | undefined)?.[name];
      const override = overrides[name];
      const value =
        override !== null && typeof override === 'object'
          ? { ...((stored as object | undefined) ?? {}), ...(override as object) }
          : (stored ?? override);

      return { value: value as T, version: row?.version ?? 0 };
    },
    patchSystem: async () => {
      throw new Error('createDbSettings: patchSystem is not part of the graph specs');
    },
    readUser: async <T>(userId: string, name: string) => {
      const row = await client.userSettings.findUnique({ where: { userId } });

      return (row?.value as Record<string, unknown> | undefined)?.[name] as T;
    },
    patchUser: async () => {
      throw new Error('createDbSettings: patchUser is not part of the graph specs');
    },
  } as unknown as KvoxSettingsPort;
}

/** An identity port that holds every permission (the specs that ask about `graph:write` for an owner). */
export function createAllowAllIdentity(): KvoxIdentityPort {
  return {
    authenticate: async () => null,
    hasPermission: async () => true,
    permissionsOf: async () => new Set<string>(),
  } as unknown as KvoxIdentityPort;
}

/** The web edition's jobs adapter over the REAL queue (`JobsService`) on `client`. */
export function createDbJobs(client: PrismaClient): { port: KvoxJobsPort; registry: JobHandlerRegistry; queue: JobsService } {
  const prisma = asPrismaService(client);
  const registry = new JobHandlerRegistry();
  const queue = new JobsService(prisma);
  const adapter = new PlatformKvoxJobsAdapter(
    queue,
    registry,
    new ProviderThrottleService({ get: () => undefined } as never),
    prisma,
    new EventEmitter2(),
  );

  return { port: adapter, registry, queue };
}

/** The graph's managed storage over the real object-store adapter (the provider is never reached). */
export function createDbGraphObjects(client: PrismaClient): GraphObjectsService {
  return new GraphObjectsService(createDbObjectStore(client, UNUSED_STORAGE));
}

/** An in-process event port. */
export const createDbEvents = createInMemoryKvoxEvents;

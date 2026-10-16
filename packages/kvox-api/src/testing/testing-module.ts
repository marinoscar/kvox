import type { DynamicModule } from '@nestjs/common';

import { KvoxPortsModule, type KvoxPortBindings } from '../core/index.js';
import type {
  KvoxAiPort,
  KvoxAuditPort,
  KvoxEventsPort,
  KvoxIdentityPort,
  KvoxJobsPort,
  KvoxNotifyPort,
  KvoxObjectStorePort,
  KvoxPrismaClientLike,
  KvoxSecretsPort,
  KvoxSettingsPort,
} from '../ports/index.js';
import { createFakeKvoxAi } from './fake-ai.js';
import { createFakeKvoxJobs } from './fake-jobs.js';
import { createFakeKvoxIdentity } from './fake-identity.js';
import { createInMemoryKvoxObjectStore } from './in-memory-object-store.js';
import {
  createInMemoryKvoxEvents,
  createInMemoryKvoxSecrets,
  createInMemoryKvoxSettings,
  createRecordingKvoxAudit,
  createRecordingKvoxNotify,
} from './recording-ports.js';

/**
 * A set of port instances, one per port.
 *
 * @stability experimental
 */
export interface KvoxFakePorts {
  /** The model port. */
  ai: KvoxAiPort;
  /** The object-store port. */
  objectStore: KvoxObjectStorePort;
  /** The job port. */
  jobs: KvoxJobsPort;
  /** The identity port. */
  identity: KvoxIdentityPort;
  /** The notification port. */
  notify: KvoxNotifyPort;
  /** The event port. */
  events: KvoxEventsPort;
  /** The database port. A bare stub: tests that need rows pass their own. */
  prisma: KvoxPrismaClientLike;
  /** The settings port. */
  settings: KvoxSettingsPort;
  /** The secrets port. */
  secrets: KvoxSecretsPort;
  /** The audit port. */
  audit: KvoxAuditPort;
}

/**
 * Builds one fake of every port.
 *
 * @param overrides - ports to use instead of the fakes.
 * @returns the ports.
 * @stability experimental
 */
export function createKvoxFakePorts(overrides: Partial<KvoxFakePorts> = {}): KvoxFakePorts {
  const unsupported = (name: string) => async (): Promise<never> => {
    throw new Error(`The fake Prisma client has no ${name}; pass your own with createKvoxTestingModule({ overrides: { prisma } }).`);
  };
  return {
    ai: createFakeKvoxAi(),
    objectStore: createInMemoryKvoxObjectStore(),
    jobs: createFakeKvoxJobs(),
    identity: createFakeKvoxIdentity(),
    notify: createRecordingKvoxNotify(),
    events: createInMemoryKvoxEvents(),
    prisma: {
      $queryRaw: unsupported('$queryRaw') as KvoxPrismaClientLike['$queryRaw'],
      $executeRaw: unsupported('$executeRaw') as KvoxPrismaClientLike['$executeRaw'],
      $transaction: unsupported('$transaction') as KvoxPrismaClientLike['$transaction'],
    },
    settings: createInMemoryKvoxSettings(),
    secrets: createInMemoryKvoxSecrets(),
    audit: createRecordingKvoxAudit(),
    ...overrides,
  };
}

/**
 * A `KvoxPortsModule.forRoot` with a fake bound to every port, for a Nest
 * testing module.
 *
 * @example
 * ```ts
 * const ports = createKvoxFakePorts();
 * const moduleRef = await Test.createTestingModule({
 *   imports: [createKvoxTestingModule({ overrides: ports })],
 *   controllers: [MyController],
 * }).compile();
 * ```
 *
 * @param options - `overrides` replaces individual fakes.
 * @returns the dynamic module.
 * @stability experimental
 */
export function createKvoxTestingModule(options: { overrides?: Partial<KvoxFakePorts> } = {}): DynamicModule {
  const ports = createKvoxFakePorts(options.overrides);
  const value = <T>(useValue: T): { useValue: T } => ({ useValue });
  const bindings: KvoxPortBindings = {
    ai: value(ports.ai),
    objectStore: value(ports.objectStore),
    jobs: value(ports.jobs),
    identity: value(ports.identity),
    notify: value(ports.notify),
    prisma: value(ports.prisma),
    settings: value(ports.settings),
    secrets: value(ports.secrets),
    events: value(ports.events),
    audit: value(ports.audit),
  };
  return KvoxPortsModule.forRoot({ ports: bindings });
}

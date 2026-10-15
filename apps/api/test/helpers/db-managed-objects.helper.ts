// =============================================================================
// Test helper: a real KvoxManagedObjects over a bare Prisma client (#469)
// =============================================================================
//
// The real-Postgres suites build their services by hand over a plain
// `PrismaClient`, which has no `runInOrg`. This adds the one method the gateway
// needs (the platform's own `runInOrg`, so the scope is set with
// `set_config(..., true)` exactly as in production) and builds the gateway over
// it. The platform's `ObjectsService` is a stub unless a spec hands one in: only
// `initManagedUpload` and `abortUpload` reach it.
//
// The suites connect as a superuser, to which row-level security does not apply;
// the scope is still opened, so a statement that forgot it would still fail the
// composite-key and ownership assertions these specs make.
// =============================================================================

import type { PrismaClient } from '@prisma/client';
import { runInOrg } from '@marinoscar/platform-api/core';
import type { ObjectsService, StorageProvider } from '@marinoscar/platform-api/storage';

import { KvoxManagedObjectsService } from '../../src/kvox-objects/kvox-managed-objects.service';
import { KvoxObjectOwnershipStore } from '../../src/kvox-objects/kvox-object-ownership.store';
import type { PrismaService } from '../../src/prisma/prisma.service';

/** The client with `runInOrg` bound to it, typed as the app's `PrismaService`. */
export function asPrismaService(client: PrismaClient): PrismaService {
  const target = client as unknown as Record<string, unknown>;

  if (typeof target.runInOrg !== 'function') {
    target.runInOrg = (scope: Parameters<typeof runInOrg>[1], fn: Parameters<typeof runInOrg>[2], options?: Parameters<typeof runInOrg>[3]) =>
      runInOrg(client as never, scope, fn as never, options);
  }

  return client as unknown as PrismaService;
}

/** A real `KvoxManagedObjectsService` over `client`, with `storage` as the provider. */
export function createDbManagedObjects(
  client: PrismaClient,
  storage: StorageProvider,
  objects: Partial<ObjectsService> = {},
): KvoxManagedObjectsService {
  return new KvoxManagedObjectsService(
    asPrismaService(client),
    new KvoxObjectOwnershipStore(),
    objects as ObjectsService,
    storage,
  );
}

/** A provider for suites whose paths never touch bytes (only the row reads and ownership are exercised). */
export const UNUSED_STORAGE: StorageProvider = {
  kind: 's3',
  getBucket: () => 'test-bucket',
} as unknown as StorageProvider;

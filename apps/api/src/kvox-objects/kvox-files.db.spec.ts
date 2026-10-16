// =============================================================================
// Real-Postgres test: the ownership side table behind the generic-object veto
// and `GET /api/kvox/files` (issue #469)
// =============================================================================
//
// What only a real database proves:
//
//   * `kvoxOwnership: { is: null }` really excludes every owned object and keeps
//     every plain one, for the caller's own rows only;
//   * the delete hook's lookup (`ManagedDeleteVeto.ownerOf`) reads the side
//     table with a plain client (the table has no RLS policy of its own);
//   * the composite foreign key `(object_id, org_id)` cascades: deleting the
//     object removes its ownership row.
//
// Forced RLS on `storage_objects` is inert until the role switch (#471), so the
// superuser test connection sees every row; the assertions are about the
// predicate, not about isolation.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { resolveDbSuite, createDbClient } from '../../test/jobs/db-test-support';
import { unmanagedFilesWhere } from './kvox-files.controller';
import { ManagedDeleteVeto } from './managed-delete.hook';
import { KvoxObjectOwnershipStore } from './kvox-object-ownership.store';
import type { PrismaService } from '../prisma/prisma.service';

const { describeWithDb, dbReachable } = resolveDbSuite('kvox-files.db.spec');

const EMAIL_PREFIX = 'kvox-files-db-test';

describeWithDb('unmanaged files and the delete veto (real Postgres)', () => {
  let prisma: PrismaClient;
  let orgId: string;
  let alice: { id: string };
  let bob: { id: string };

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = createDbClient();
    await prisma.$connect();
    const org = await prisma.organization.findFirst({ where: { isDefault: true }, select: { id: true } });
    if (!org) throw new Error('No default organization; run the platform migrations.');
    orgId = org.id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    alice = await prisma.user.create({ data: { email: `${EMAIL_PREFIX}-a-${stamp}@example.test` }, select: { id: true } });
    bob = await prisma.user.create({ data: { email: `${EMAIL_PREFIX}-b-${stamp}@example.test` }, select: { id: true } });
  });

  afterEach(async () => {
    if (!dbReachable) return;
    // The ownership rows cascade with the objects.
    await prisma.storageObject.deleteMany({ where: { uploadedBy: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  function createObject(uploadedById: string, name: string, managedBy?: 'transcripts' | 'notes' | 'graph') {
    return prisma.storageObject.create({
      data: {
        name,
        size: BigInt(1024),
        mimeType: 'audio/mp4',
        storageKey: `uploads/${orgId}/${Date.now()}/${randomUUID()}.m4a`,
        storageProvider: 's3',
        bucket: 'test-bucket',
        status: 'ready',
        orgId,
        uploadedById,
        ...(managedBy ? { kvoxOwnership: { create: { managedBy } } } : {}),
      },
    });
  }

  it('lists the caller\'s plain uploads and nothing a module owns', async () => {
    const plain = await createObject(alice.id, 'plain.m4a');
    await createObject(alice.id, 'transcript-source.m4a', 'transcripts');
    await createObject(alice.id, 'note-source.pdf', 'notes');
    await createObject(alice.id, 'graph-export.ttl', 'graph');
    await createObject(bob.id, 'bobs.m4a');

    const rows = await prisma.storageObject.findMany({ where: unmanagedFilesWhere(alice.id) });
    expect(rows.map((row) => row.id)).toEqual([plain.id]);

    const total = await prisma.storageObject.count({ where: unmanagedFilesWhere(alice.id) });
    expect(total).toBe(1);
  });

  it('keeps the status filter', async () => {
    await createObject(alice.id, 'ready.m4a');
    const failed = await createObject(alice.id, 'failed.m4a');
    await prisma.storageObject.update({ where: { id: failed.id }, data: { status: 'failed' } });

    const rows = await prisma.storageObject.findMany({ where: unmanagedFilesWhere(alice.id, 'failed') });
    expect(rows.map((row) => row.id)).toEqual([failed.id]);
  });

  it('answers the owning module for a managed object and null for a plain one', async () => {
    const veto = new ManagedDeleteVeto(prisma as unknown as PrismaService, new KvoxObjectOwnershipStore());
    const managed = await createObject(alice.id, 'source.m4a', 'transcripts');
    const plain = await createObject(alice.id, 'plain.m4a');

    await expect(veto.ownerOf(managed.id)).resolves.toBe('transcripts');
    await expect(veto.ownerOf(plain.id)).resolves.toBeNull();
    await expect(veto.ownerOf(randomUUID())).resolves.toBeNull();
  });

  it('removes the ownership row when the object is deleted (composite foreign key cascade)', async () => {
    const managed = await createObject(alice.id, 'source.m4a', 'notes');
    expect(await prisma.kvoxObjectOwnership.count({ where: { objectId: managed.id } })).toBe(1);

    await prisma.storageObject.delete({ where: { id: managed.id } });

    expect(await prisma.kvoxObjectOwnership.count({ where: { objectId: managed.id } })).toBe(0);
  });
});

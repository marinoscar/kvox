import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { KvoxManagedObjectsService } from './kvox-managed-objects.service';
import { isMimeTypeAllowed, resolveMimeType } from './upload-mime';

// =============================================================================
// KvoxManagedObjects (issue #469)
// =============================================================================
//
// `initManagedUpload` is where the content type is made honest BEFORE the
// platform's `initUpload` sees it: a browser sends `""` or
// `application/octet-stream` for an `.m4a` or `.amr`, which the platform would
// answer 415, and the transcript allowlist (audio/video) is the module's, not
// the operator's. Everything else here is the org scope and ownership rules.
// =============================================================================

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const AUDIO_VIDEO = ['audio/*', 'video/*'];

function build() {
  const tx = {
    storageObject: {
      findUnique: jest.fn(),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'obj-1', ...data })),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    organization: { findFirst: jest.fn().mockResolvedValue({ id: ORG }) },
    runInOrg: jest.fn(async (_scope: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  const ownership = {
    stamp: jest.fn().mockResolvedValue(undefined),
    managedBy: jest.fn().mockResolvedValue(new Map<string, string>()),
  };
  const objects = {
    initUpload: jest.fn().mockResolvedValue({
      objectId: 'obj-1',
      uploadId: 'up-1',
      partSize: 10,
      totalParts: 1,
      presignedUrls: [],
    }),
    abortUpload: jest.fn().mockResolvedValue(undefined),
  };
  const storage = {
    kind: 's3',
    getBucket: () => 'bucket',
    delete: jest.fn().mockResolvedValue(undefined),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
  };
  const service = new KvoxManagedObjectsService(
    prisma as never,
    ownership as never,
    objects as never,
    storage as never,
  );
  return { service, prisma, tx, ownership, objects, storage };
}

describe('resolveMimeType / isMimeTypeAllowed', () => {
  it.each([
    ['rec.m4a', '', 'audio/mp4'],
    ['rec.amr', 'application/octet-stream', 'audio/amr'],
    ['rec.mp3', 'binary/octet-stream', 'audio/mpeg'],
    ['rec.m4a', 'audio/x-m4a', 'audio/x-m4a'],
    ['clip.mov', 'video/quicktime', 'video/quicktime'],
  ])('%s declared as "%s" is stored as %s', (name, declared, expected) => {
    expect(resolveMimeType(name, declared)).toBe(expected);
  });

  it('cannot rescue a generic type with no audio extension', () => {
    expect(resolveMimeType('notes.bin', 'application/octet-stream')).toBe('application/octet-stream');
    expect(resolveMimeType('notes.bin', '')).toBeNull();
  });

  it('matches families and ignores parameters and case', () => {
    expect(isMimeTypeAllowed('Audio/MPEG; charset=x', AUDIO_VIDEO)).toBe(true);
    expect(isMimeTypeAllowed('application/pdf', AUDIO_VIDEO)).toBe(false);
  });
});

describe('KvoxManagedObjectsService.initManagedUpload', () => {
  const base = { module: 'transcripts' as const, userId: USER, size: 1000, allowedMimeTypes: AUDIO_VIDEO };

  it('resolves a typeless .m4a to audio/mp4 BEFORE the platform sees it', async () => {
    const { service, objects } = build();

    await service.initManagedUpload({ ...base, name: 'recording.m4a', mimeType: '' });

    expect(objects.initUpload).toHaveBeenCalledWith(
      { name: 'recording.m4a', size: 1000, mimeType: 'audio/mp4' },
      USER,
      ORG,
    );
  });

  it('accepts an absent content type when the extension is an audio one', async () => {
    const { service, objects } = build();

    await service.initManagedUpload({ ...base, name: 'voice.amr', mimeType: undefined });

    expect(objects.initUpload).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'audio/amr' }), USER, ORG);
  });

  it('refuses a type outside the module allowlist with a 400 naming it, and starts no upload', async () => {
    const { service, objects } = build();

    await expect(
      service.initManagedUpload({ ...base, name: 'contract.pdf', mimeType: 'application/pdf' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.initManagedUpload({ ...base, name: 'contract.pdf', mimeType: 'application/pdf' }),
    ).rejects.toThrow(/audio\/\*, video\/\*/);

    expect(objects.initUpload).not.toHaveBeenCalled();
  });

  it('refuses a typeless file whose extension cannot rescue it', async () => {
    const { service, objects } = build();

    await expect(service.initManagedUpload({ ...base, name: 'data.bin', mimeType: '' })).rejects.toThrow(
      BadRequestException,
    );
    expect(objects.initUpload).not.toHaveBeenCalled();
  });

  it('stamps the ownership row for the new object in the caller org', async () => {
    const { service, ownership } = build();

    await service.initManagedUpload({ ...base, name: 'a.mp3', mimeType: 'audio/mpeg' });

    expect(ownership.stamp).toHaveBeenCalledWith(expect.anything(), {
      objectId: 'obj-1',
      orgId: ORG,
      module: 'transcripts',
    });
  });

  it('aborts the upload rather than leave an unowned object when the stamp fails', async () => {
    const { service, ownership, objects } = build();
    ownership.stamp.mockRejectedValue(new Error('db down'));

    await expect(service.initManagedUpload({ ...base, name: 'a.mp3', mimeType: 'audio/mpeg' })).rejects.toThrow(
      'db down',
    );
    expect(objects.abortUpload).toHaveBeenCalledWith('obj-1', USER, ORG);
  });
});

describe('KvoxManagedObjectsService.create / deleteManaged', () => {
  it('creates the row and its ownership in one org-scoped transaction', async () => {
    const { service, prisma, ownership, tx } = build();

    const row = await service.create({
      module: 'notes',
      key: 'notes/n1/exports/a.pdf',
      mimeType: 'application/pdf',
      size: 5,
      uploadedById: USER,
    });

    expect(prisma.runInOrg).toHaveBeenCalledTimes(1);
    expect(prisma.runInOrg).toHaveBeenCalledWith({ orgId: ORG }, expect.any(Function));
    expect(tx.storageObject.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ storageKey: 'notes/n1/exports/a.pdf', orgId: ORG, status: 'ready', size: BigInt(5) }),
    });
    expect(ownership.stamp).toHaveBeenCalledWith(tx, { objectId: row.id, orgId: ORG, module: 'notes' });
  });

  it('uses the caller transaction instead of opening one', async () => {
    const { service, prisma, tx } = build();

    await service.get('obj-1', { tx: tx as never });

    expect(prisma.runInOrg).not.toHaveBeenCalled();
    expect(tx.storageObject.findUnique).toHaveBeenCalledWith({ where: { id: 'obj-1' } });
  });

  it('deletes bytes then row for the owning module', async () => {
    const { service, tx, ownership, storage } = build();
    tx.storageObject.findUnique.mockResolvedValue({ id: 'obj-1', storageKey: 'k', status: 'ready', s3UploadId: null });
    ownership.managedBy.mockResolvedValue(new Map([['obj-1', 'graph']]));

    await service.deleteManaged('obj-1', 'graph');

    expect(storage.delete).toHaveBeenCalledWith('k');
    expect(tx.storageObject.deleteMany).toHaveBeenCalledWith({ where: { id: 'obj-1' } });
  });

  it('aborts an unfinished multipart upload before removing the row', async () => {
    const { service, tx, ownership, storage } = build();
    tx.storageObject.findUnique.mockResolvedValue({ id: 'obj-1', storageKey: 'k', status: 'uploading', s3UploadId: 'up-1' });
    ownership.managedBy.mockResolvedValue(new Map([['obj-1', 'transcripts']]));

    await service.deleteManaged('obj-1', 'transcripts');

    expect(storage.abortMultipartUpload).toHaveBeenCalledWith('k', 'up-1');
  });

  it('is a 409 for the wrong module and deletes nothing', async () => {
    const { service, tx, ownership, storage } = build();
    tx.storageObject.findUnique.mockResolvedValue({ id: 'obj-1', storageKey: 'k', status: 'ready', s3UploadId: null });
    ownership.managedBy.mockResolvedValue(new Map([['obj-1', 'notes']]));

    await expect(service.deleteManaged('obj-1', 'transcripts')).rejects.toThrow(ConflictException);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('is a 404 for an object that is gone', async () => {
    const { service, tx } = build();
    tx.storageObject.findUnique.mockResolvedValue(null);

    await expect(service.deleteManaged('obj-1', 'notes')).rejects.toThrow(NotFoundException);
  });
});

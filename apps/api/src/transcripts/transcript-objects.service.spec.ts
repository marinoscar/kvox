import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import { ObjectsService } from '../storage/objects/objects.service';
import { STORAGE_PROVIDER } from '../storage/providers/storage-provider.interface';
import { TRANSCRIPTS_MANAGED_BY } from './job-types';
import {
  MissingUploadedObjectError,
  TranscriptObjectsService,
} from './transcript-objects.service';

// =============================================================================
// `recordUploaded` — recording bytes this process never held (issue #26)
// =============================================================================
//
// The method exists for one case `put` structurally cannot serve: a worker
// node PUTs the playback rendition straight to a presigned URL, so the API
// server never sees a byte of it and there is nothing to hand `put`.
//
// Two properties, and both of them are about what happens when something has
// already gone wrong elsewhere:
//
//   • THE READ-BACK CHECK. A node whose upload silently failed would otherwise
//     leave `playback_object_id` aimed at an empty key and a transcript whose
//     audio element plays nothing. One HEAD request is what separates "a row
//     that describes a file" from "a row".
//   • IDEMPOTENCE ON THE KEY. The queue is at-least-once and the rendition's
//     key is a pure function of the job, so a retry after a committed record
//     arrives here with a key that already has a row.
// =============================================================================

describe('TranscriptObjectsService.recordUploaded', () => {
  let service: TranscriptObjectsService;
  let prisma: { storageObject: { findFirst: jest.Mock; create: jest.Mock } };
  let storage: { exists: jest.Mock; getBucket: jest.Mock; upload: jest.Mock };

  const input = {
    storageKey: 'transcripts/t-1/renditions/j-1.m4a',
    name: 'playback.m4a',
    mimeType: 'audio/mp4',
    size: 512_000,
    ownerId: 'user-1',
    metadata: { transcriptId: 't-1' },
  };

  beforeEach(async () => {
    prisma = {
      storageObject: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'object-1' }),
      },
    };

    storage = {
      exists: jest.fn().mockResolvedValue(true),
      getBucket: jest.fn().mockReturnValue('bucket'),
      upload: jest.fn().mockResolvedValue({}),
    };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptObjectsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ObjectsService, useValue: { deleteManagedObject: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn((_k, d) => d) } },
        { provide: STORAGE_PROVIDER, useValue: storage },
      ],
    }).compile();

    service = module.get(TranscriptObjectsService);
  });

  it('checks the bytes really landed, then records them as a MANAGED object', async () => {
    await expect(service.recordUploaded(input)).resolves.toEqual({ id: 'object-1' });

    expect(storage.exists).toHaveBeenCalledWith(input.storageKey);
    expect(prisma.storageObject.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storageKey: input.storageKey,
        mimeType: 'audio/mp4',
        size: BigInt(512_000),
        status: 'ready',
        // Invisible to `GET /api/storage/objects` and undeletable through the
        // generic DELETE — the ownership boundary a transcript's files need.
        managedBy: TRANSCRIPTS_MANAGED_BY,
        uploadedById: 'user-1',
      }),
    });
  });

  it('refuses a key that holds nothing, with a message naming the key', async () => {
    storage.exists.mockResolvedValue(false);

    await expect(service.recordUploaded(input)).rejects.toThrow(MissingUploadedObjectError);
    await expect(service.recordUploaded(input)).rejects.toThrow(input.storageKey);

    expect(prisma.storageObject.create).not.toHaveBeenCalled();
  });

  it('reuses the existing row for a key already recorded, creating no duplicate', async () => {
    prisma.storageObject.findFirst.mockResolvedValue({ id: 'object-0' });

    await expect(service.recordUploaded(input)).resolves.toEqual({ id: 'object-0' });

    expect(prisma.storageObject.create).not.toHaveBeenCalled();
    // Not even the HEAD: the row is already proof that the bytes were there,
    // and a retry should not pay a round trip to re-establish it.
    expect(storage.exists).not.toHaveBeenCalled();
  });

  it('leaves `put` on its own path — bytes it uploads are not re-checked', async () => {
    await service.put({
      storageKey: 'transcripts/t-1/raw/x.json.gz',
      name: 'x.json.gz',
      mimeType: 'application/gzip',
      body: Buffer.from('hello'),
      ownerId: 'user-1',
    });

    expect(storage.upload).toHaveBeenCalled();
    // This process just wrote them and the write is awaited; a HEAD to confirm
    // its own successful upload would be a round trip per raw result for no
    // information.
    expect(storage.exists).not.toHaveBeenCalled();
  });
});

// =============================================================================
// `deleteIfPresent` — purge is re-entrant, so a delete that fails must not
// blow up the caller (issue #101's abort-before-delete can surface a fresh
// kind of failure here: a non-NoSuchUpload abort error rethrown by
// `ObjectsService.deleteManagedObject`).
// =============================================================================
describe('TranscriptObjectsService.deleteIfPresent', () => {
  let service: TranscriptObjectsService;
  let objects: { deleteManagedObject: jest.Mock };

  beforeEach(async () => {
    objects = { deleteManagedObject: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptObjectsService,
        { provide: PrismaService, useValue: {} },
        { provide: ObjectsService, useValue: objects },
        { provide: ConfigService, useValue: { get: jest.fn((_k, d) => d) } },
        { provide: STORAGE_PROVIDER, useValue: {} },
      ],
    }).compile();

    service = module.get(TranscriptObjectsService);
  });

  it('returns false, and does not throw, when the underlying delete rejects with a non-NoSuchUpload error', async () => {
    const accessDenied = Object.assign(new Error('Access Denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    objects.deleteManagedObject.mockRejectedValue(accessDenied);

    await expect(service.deleteIfPresent('object-1')).resolves.toBe(false);

    expect(objects.deleteManagedObject).toHaveBeenCalledWith(
      'object-1',
      TRANSCRIPTS_MANAGED_BY,
    );
  });

  it('returns true when the delete succeeds', async () => {
    objects.deleteManagedObject.mockResolvedValue(undefined);

    await expect(service.deleteIfPresent('object-1')).resolves.toBe(true);
  });

  it('returns false without calling the delete at all for a null/undefined id', async () => {
    await expect(service.deleteIfPresent(null)).resolves.toBe(false);
    await expect(service.deleteIfPresent(undefined)).resolves.toBe(false);

    expect(objects.deleteManagedObject).not.toHaveBeenCalled();
  });
});

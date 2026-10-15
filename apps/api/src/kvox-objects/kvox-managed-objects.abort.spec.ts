import { BadRequestException, NotFoundException } from '@nestjs/common';

import { KvoxManagedObjectsService } from './kvox-managed-objects.service';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ID = '44444444-4444-4444-8444-444444444444';

function object(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    uploadedById: USER,
    storageKey: 'uploads/org/1/abc.m4a',
    s3UploadId: 'upload-1',
    status: 'uploading',
    ...overrides,
  };
}

describe('KvoxManagedObjectsService.abortManaged', () => {
  let tx: {
    storageObject: { findUnique: jest.Mock; updateMany: jest.Mock; deleteMany: jest.Mock };
    transcript: { updateMany: jest.Mock };
  };
  let ownership: { managedBy: jest.Mock };
  let storage: { abortMultipartUpload: jest.Mock; delete: jest.Mock };
  let service: KvoxManagedObjectsService;

  beforeEach(() => {
    tx = {
      storageObject: {
        findUnique: jest.fn().mockResolvedValue(object()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn(),
      },
      transcript: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    ownership = { managedBy: jest.fn().mockResolvedValue(new Map([[ID, 'transcripts']])) };
    storage = { abortMultipartUpload: jest.fn().mockResolvedValue(undefined), delete: jest.fn() };
    service = new KvoxManagedObjectsService({} as never, ownership as never, {} as never, storage as never);
  });

  const abort = (userId = USER) => service.abortManaged(ID, userId, { tx: tx as never });

  it('aborts the provider upload, keeps the row as failed and fails the uploading transcript', async () => {
    await abort();

    expect(storage.abortMultipartUpload).toHaveBeenCalledWith('uploads/org/1/abc.m4a', 'upload-1');
    expect(tx.storageObject.updateMany).toHaveBeenCalledWith({
      where: { id: ID, status: { in: ['pending', 'uploading'] } },
      data: { status: 'failed', s3UploadId: null },
    });
    expect(tx.transcript.updateMany).toHaveBeenCalledWith({
      where: { sourceObjectId: ID, deletedAt: null, status: 'uploading' },
      data: { status: 'failed', failureReason: 'upload_aborted' },
    });
    expect(tx.storageObject.deleteMany).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('leaves transcripts alone for a note or graph owner', async () => {
    ownership.managedBy.mockResolvedValue(new Map([[ID, 'notes']]));
    await abort();
    expect(tx.storageObject.updateMany).toHaveBeenCalled();
    expect(tx.transcript.updateMany).not.toHaveBeenCalled();
  });

  it('is idempotent for an already failed object (no provider call, still reconciles the transcript)', async () => {
    tx.storageObject.findUnique.mockResolvedValue(object({ status: 'failed', s3UploadId: null }));
    await abort();
    expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    expect(tx.transcript.updateMany).toHaveBeenCalled();
  });

  it('still settles the row when the provider no longer knows the upload', async () => {
    storage.abortMultipartUpload.mockRejectedValue(Object.assign(new Error('gone'), { name: 'NoSuchUpload' }));
    await abort();
    expect(tx.storageObject.updateMany).toHaveBeenCalled();
  });

  it('answers 404 for another user\'s object, a missing object and an unmanaged object', async () => {
    await expect(abort(OTHER)).rejects.toBeInstanceOf(NotFoundException);

    tx.storageObject.findUnique.mockResolvedValueOnce(null);
    await expect(abort()).rejects.toBeInstanceOf(NotFoundException);

    ownership.managedBy.mockResolvedValueOnce(new Map());
    await expect(abort()).rejects.toBeInstanceOf(NotFoundException);

    expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    expect(tx.storageObject.updateMany).not.toHaveBeenCalled();
  });

  it.each(['processing', 'ready'])('answers 400 for an upload that is already %s', async (status) => {
    tx.storageObject.findUnique.mockResolvedValue(object({ status }));
    await expect(abort()).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.transcript.updateMany).not.toHaveBeenCalled();
  });
});

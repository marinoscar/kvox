import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

import { KvoxMultipartController, MAX_PRESIGN_BATCH, presignPartsSchema } from './kvox-multipart.controller';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const OBJECT_ID = '44444444-4444-4444-8444-444444444444';
const MIB = 1024 * 1024;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: OBJECT_ID,
    uploadedById: USER,
    storageKey: 'uploads/org/1/abc.m4a',
    s3UploadId: 'upload-1',
    status: 'uploading',
    size: BigInt(2000 * MIB), // 200 parts at 10 MiB
    ...overrides,
  };
}

describe('KvoxMultipartController', () => {
  let managed: { get: jest.Mock };
  let lister: { listParts: jest.Mock };
  let storage: { getSignedUploadUrl: jest.Mock };
  let config: { get: jest.Mock };
  let controller: KvoxMultipartController;

  beforeEach(() => {
    managed = { get: jest.fn().mockResolvedValue(row()) };
    lister = { listParts: jest.fn().mockResolvedValue([{ partNumber: 1, etag: '"a"', size: 10 * MIB }]) };
    storage = {
      getSignedUploadUrl: jest.fn(async (_key: string, _uploadId: string, partNumber: number) => `https://s3.test/part/${partNumber}`),
    };
    config = { get: jest.fn((_key: string, fallback: number) => fallback) };
    controller = new KvoxMultipartController(managed as never, lister as never, config as never, storage as never, undefined);
  });

  describe('routes', () => {
    it('mounts both handlers at storage/objects/:id/upload/parts', () => {
      const proto = KvoxMultipartController.prototype;
      expect(Reflect.getMetadata(PATH_METADATA, KvoxMultipartController)).toBe('storage/objects');
      expect(Reflect.getMetadata(PATH_METADATA, proto.presignParts)).toBe(':id/upload/parts');
      expect(Reflect.getMetadata(METHOD_METADATA, proto.presignParts)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(PATH_METADATA, proto.listParts)).toBe(':id/upload/parts');
      expect(Reflect.getMetadata(METHOD_METADATA, proto.listParts)).toBe(RequestMethod.GET);
    });
  });

  describe('presignParts', () => {
    it('signs the requested parts of the caller\'s own upload (parts beyond the first ten)', async () => {
      const result = await controller.presignParts(OBJECT_ID, { partNumbers: [11, 12, 120] }, USER, ORG);

      expect(managed.get).toHaveBeenCalledWith(OBJECT_ID, { orgId: ORG });
      expect(result.data).toEqual([
        { partNumber: 11, url: 'https://s3.test/part/11' },
        { partNumber: 12, url: 'https://s3.test/part/12' },
        { partNumber: 120, url: 'https://s3.test/part/120' },
      ]);
      expect(storage.getSignedUploadUrl).toHaveBeenCalledWith('uploads/org/1/abc.m4a', 'upload-1', 11);
    });

    it('answers 404 (never 403) for another user\'s object and for a missing one', async () => {
      managed.get.mockResolvedValueOnce(row({ uploadedById: OTHER }));
      await expect(controller.presignParts(OBJECT_ID, { partNumbers: [1] }, USER, ORG)).rejects.toBeInstanceOf(NotFoundException);

      managed.get.mockResolvedValueOnce(null);
      await expect(controller.presignParts(OBJECT_ID, { partNumbers: [1] }, USER, ORG)).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.getSignedUploadUrl).not.toHaveBeenCalled();
    });

    it.each(['processing', 'ready', 'failed'])('answers 400 for an upload that is %s', async (status) => {
      managed.get.mockResolvedValueOnce(row({ status }));
      await expect(controller.presignParts(OBJECT_ID, { partNumbers: [1] }, USER, ORG)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('answers 400 for an object with no multipart upload id', async () => {
      managed.get.mockResolvedValueOnce(row({ s3UploadId: null }));
      await expect(controller.presignParts(OBJECT_ID, { partNumbers: [1] }, USER, ORG)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('answers 400 for a part number beyond the upload\'s total parts', async () => {
      await expect(controller.presignParts(OBJECT_ID, { partNumbers: [201] }, USER, ORG)).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.presignParts(OBJECT_ID, { partNumbers: [200] }, USER, ORG)).resolves.toBeDefined();
    });

    it('derives the part count from the deployment-wide part size', async () => {
      config.get.mockReturnValue(100 * MIB); // 20 parts for 2000 MiB
      await expect(controller.presignParts(OBJECT_ID, { partNumbers: [21] }, USER, ORG)).rejects.toBeInstanceOf(BadRequestException);

      const withOption = new KvoxMultipartController(managed as never, lister as never, config as never, storage as never, {
        partSizeBytes: 50 * MIB,
      } as never);
      await expect(withOption.presignParts(OBJECT_ID, { partNumbers: [40] }, USER, ORG)).resolves.toBeDefined();
    });
  });

  describe('presignPartsSchema', () => {
    it('accepts 1..100 distinct part numbers', () => {
      expect(presignPartsSchema.safeParse({ partNumbers: [1] }).success).toBe(true);
      expect(presignPartsSchema.safeParse({ partNumbers: Array.from({ length: MAX_PRESIGN_BATCH }, (_, i) => i + 1) }).success).toBe(true);
    });

    it.each([
      ['empty', { partNumbers: [] }],
      ['more than 100', { partNumbers: Array.from({ length: MAX_PRESIGN_BATCH + 1 }, (_, i) => i + 1) }],
      ['duplicate', { partNumbers: [3, 3] }],
      ['zero', { partNumbers: [0] }],
      ['above 10,000', { partNumbers: [10_001] }],
      ['fractional', { partNumbers: [1.5] }],
      ['missing', {}],
    ])('rejects %s', (_label, body) => {
      expect(presignPartsSchema.safeParse(body).success).toBe(false);
    });
  });

  describe('listParts', () => {
    it('returns the provider\'s parts for the caller\'s own upload', async () => {
      const result = await controller.listParts(OBJECT_ID, USER, ORG);

      expect(lister.listParts).toHaveBeenCalledWith('uploads/org/1/abc.m4a', 'upload-1');
      expect(result).toEqual({ data: [{ partNumber: 1, etag: '"a"', size: 10 * MIB }] });
    });

    it('answers 404 for another user\'s object without asking the provider', async () => {
      managed.get.mockResolvedValueOnce(row({ uploadedById: OTHER }));
      await expect(controller.listParts(OBJECT_ID, USER, ORG)).rejects.toBeInstanceOf(NotFoundException);
      expect(lister.listParts).not.toHaveBeenCalled();
    });

    it('propagates the lister\'s 501 for a non-S3 driver', async () => {
      const unsupported = new Error('unsupported');
      lister.listParts.mockRejectedValueOnce(unsupported);
      await expect(controller.listParts(OBJECT_ID, USER, ORG)).rejects.toBe(unsupported);
    });

    it('answers 400 once the upload settled', async () => {
      managed.get.mockResolvedValueOnce(row({ status: 'ready', s3UploadId: null }));
      await expect(controller.listParts(OBJECT_ID, USER, ORG)).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

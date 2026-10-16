import { DEFAULT_STORAGE_PART_SIZE_BYTES } from '@marinoscar/platform-api/storage';

import { S3_MAX_PARTS, maxObjectBytes, resolvePartSize, totalPartsFor } from './part-size';

const GIB = 1024 ** 3;

describe('kvox part size', () => {
  describe('resolvePartSize', () => {
    it('prefers the forRoot option', () => {
      const config = { get: jest.fn() };
      expect(resolvePartSize(config as never, { partSizeBytes: 64 * 1024 * 1024 })).toBe(64 * 1024 * 1024);
      expect(config.get).not.toHaveBeenCalled();
    });

    it('falls back to the storage.partSize config key, then the platform default', () => {
      const config = { get: jest.fn((_key: string, fallback: number) => fallback) };
      expect(resolvePartSize(config as never, null)).toBe(DEFAULT_STORAGE_PART_SIZE_BYTES);
      expect(config.get).toHaveBeenCalledWith('storage.partSize', DEFAULT_STORAGE_PART_SIZE_BYTES);

      expect(resolvePartSize({ get: () => 20 * 1024 * 1024 } as never, undefined)).toBe(20 * 1024 * 1024);
    });
  });

  describe('totalPartsFor', () => {
    it('rounds up and accepts a bigint size', () => {
      expect(totalPartsFor(BigInt(25 * 1024 * 1024), 10 * 1024 * 1024)).toBe(3);
      expect(totalPartsFor(10 * 1024 * 1024, 10 * 1024 * 1024)).toBe(1);
    });
  });

  // The 10,000-part ceiling versus the largest size KVox accepts (issue #469):
  // the platform default must carry the biggest transcription input and the
  // default deployment-wide file-size limit, so no adaptive sizing is needed.
  describe('the 10,000-part ceiling at the platform default', () => {
    const LARGEST_TRANSCRIPTION_INPUT = 5 * GIB; // AssemblyAI maxInputBytes, the largest registered provider
    const DEFAULT_MAX_FILE_SIZE = 10 * GIB; // storage.maxFileSize (MAX_FILE_SIZE) default

    it('carries the largest transcription input and the default file-size limit', () => {
      const ceiling = maxObjectBytes(DEFAULT_STORAGE_PART_SIZE_BYTES);
      expect(ceiling).toBeGreaterThanOrEqual(LARGEST_TRANSCRIPTION_INPUT);
      expect(ceiling).toBeGreaterThanOrEqual(DEFAULT_MAX_FILE_SIZE);
      expect(totalPartsFor(DEFAULT_MAX_FILE_SIZE, DEFAULT_STORAGE_PART_SIZE_BYTES)).toBeLessThanOrEqual(S3_MAX_PARTS);
    });

    it('is partSize * 10,000', () => {
      expect(maxObjectBytes(10 * 1024 * 1024)).toBe(10 * 1024 * 1024 * 10_000);
    });
  });
});

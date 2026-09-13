import { Readable } from 'stream';
import {
  StorageProvider,
  StorageUploadResult,
  MultipartUploadInit,
  UploadPart,
  SignedUrlOptions,
  StorageUploadOptions,
} from '../../src/storage/providers';

/**
 * Creates a mock storage provider for testing
 * All methods return sensible defaults that can be overridden in tests
 */
export const createMockStorageProvider = (): jest.Mocked<StorageProvider> => ({
  upload: jest.fn().mockResolvedValue({
    key: 'test-key',
    bucket: 'test-bucket',
    location: 's3://test-bucket/test-key',
    eTag: '"mock-etag"',
  } as StorageUploadResult),

  initMultipartUpload: jest.fn().mockResolvedValue({
    uploadId: 'mock-upload-id',
    key: 'test-key',
  } as MultipartUploadInit),

  getSignedUploadUrl: jest
    .fn()
    .mockResolvedValue('https://mock-presigned-url.com/upload'),

  // Single-shot signed PUT (#269). Distinct from the multipart part URL above
  // so a spec asserting "the node was given a WRITE url" cannot pass because
  // the wrong method happened to be stubbed with the same string.
  getSignedPutUrl: jest
    .fn()
    .mockResolvedValue('https://mock-presigned-url.com/put'),

  completeMultipartUpload: jest.fn().mockResolvedValue({
    key: 'test-key',
    bucket: 'test-bucket',
    location: 's3://test-bucket/test-key',
    eTag: '"mock-etag"',
  } as StorageUploadResult),

  abortMultipartUpload: jest.fn().mockResolvedValue(undefined),

  download: jest.fn().mockResolvedValue(Readable.from(['mock content'])),

  getSignedDownloadUrl: jest
    .fn()
    .mockResolvedValue('https://mock-presigned-url.com/download'),

  delete: jest.fn().mockResolvedValue(undefined),

  getMetadata: jest
    .fn()
    .mockResolvedValue({ 'x-custom': 'value' } as Record<string, string>),

  setMetadata: jest.fn().mockResolvedValue(undefined),

  exists: jest.fn().mockResolvedValue(true),

  getBucket: jest.fn().mockReturnValue('test-bucket'),
});

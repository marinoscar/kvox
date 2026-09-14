import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Readable } from 'node:stream';

import { ObjectsService } from './objects.service';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../providers/storage-provider.interface';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';
import { createMockStorageProvider } from '../../../test/mocks/storage-provider.mock';
import { OBJECT_UPLOADED_EVENT } from '../processing/events/object-uploaded.event';

describe('ObjectsService', () => {
  let service: ObjectsService;
  let mockPrisma: MockPrismaService;
  let mockStorageProvider: ReturnType<typeof createMockStorageProvider>;
  let mockConfig: jest.Mocked<ConfigService>;
  let configValues: Record<string, unknown>;
  let mockEventEmitter: jest.Mocked<EventEmitter2>;

  const testUserId = 'user-123';
  const otherUserId = 'user-456';

  const mockStorageObject = {
    id: 'obj-123',
    name: 'test-file.pdf',
    size: BigInt(1024000),
    mimeType: 'application/pdf',
    storageKey: 'uploads/123456/uuid-123.pdf',
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: 'ready',
    s3UploadId: null,
    partSize: 10485760,
    managedBy: null,
    uploadedById: testUserId,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockStorageProvider = createMockStorageProvider();
    // ⚠ KEY-AWARE, not a single blanket return value (#21). `initUpload` now
    // reads FOUR settings — part size, max file size, the MIME allowlist and
    // the signed-URL expiry — so a `mockReturnValue(10485760)` would hand the
    // allowlist an integer and the size limit a part size, and every test in
    // this file would fail for reasons that have nothing to do with what it
    // is testing. `configValues` is the deployment's configuration; a test
    // that cares overrides one key.
    configValues = {
      'storage.partSize': 10485760,
      'storage.maxFileSize': 10737418240,
      'storage.allowedMimeTypes': [
        'image/*',
        'application/pdf',
        'video/*',
        'audio/*',
        // The pre-#21 fixtures in this file upload .zip files; kept allowed so
        // those tests keep testing what they were written to test.
        'application/zip',
      ],
      'storage.signedUrlExpiry': 3600,
    };
    mockConfig = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key in configValues ? configValues[key] : fallback,
      ),
    } as any;
    mockEventEmitter = {
      emit: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ObjectsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: ConfigService, useValue: mockConfig },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<ObjectsService>(ObjectsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initUpload', () => {
    it('should create object record and return presigned URLs', async () => {
      const dto = {
        name: 'test.pdf',
        size: 52428800, // 50MB
        mimeType: 'application/pdf',
      };

      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-123',
        key: 'uploads/123/uuid.pdf',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
        id: 'new-obj-id',
        name: dto.name,
        size: BigInt(dto.size),
        status: 'pending',
        s3UploadId: 'upload-123',
      } as any);

      const result = await service.initUpload(dto, testUserId);

      expect(result.objectId).toBe('new-obj-id');
      expect(result.uploadId).toBe('upload-123');
      expect(result.partSize).toBe(10485760);
      expect(result.totalParts).toBe(5); // 50MB / 10MB
      expect(result.presignedUrls).toHaveLength(5); // First batch up to 10
      expect(mockStorageProvider.initMultipartUpload).toHaveBeenCalled();
      expect(mockPrisma.storageObject.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: dto.name,
            size: BigInt(dto.size),
            mimeType: dto.mimeType,
            status: 'pending',
            s3UploadId: 'upload-123',
            uploadedById: testUserId,
          }),
        }),
      );
    });

    it('should calculate correct part count for large files', async () => {
      const dto = {
        name: 'large.zip',
        size: 104857600, // 100MB
        mimeType: 'application/zip',
      };

      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-456',
        key: 'uploads/456/uuid.zip',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
        id: 'new-obj-id',
      } as any);

      const result = await service.initUpload(dto, testUserId);

      expect(result.totalParts).toBe(10); // 100MB / 10MB
      expect(result.presignedUrls).toHaveLength(10); // First batch of 10
    });

    it('should generate unique storage key with timestamp and UUID', async () => {
      const dto = {
        name: 'test.pdf',
        size: 10485760,
        mimeType: 'application/pdf',
      };

      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-789',
        key: 'test-key',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
      } as any);

      await service.initUpload(dto, testUserId);

      expect(mockPrisma.storageObject.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            storageKey: expect.stringMatching(/^uploads\/\d+\/[a-f0-9-]+\.pdf$/),
          }),
        }),
      );
    });

    // Before #21 this was the assertion that a 500 GB file is REJECTED. It is
    // now the assertion that it is accepted, because the part size adapts —
    // the rejection was the bug.
    it('should accept a file that would exceed 10,000 parts at the configured part size', async () => {
      const dto = {
        name: 'huge.wav',
        size: 524288000000, // 500 GB — 50,000 parts at the configured 10 MiB
        mimeType: 'audio/wav',
      };

      // This deployment is configured to accept it; the point of the test is
      // the SLICING, not the size limit.
      configValues['storage.maxFileSize'] = 1099511627776; // 1 TiB

      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-huge',
        key: 'uploads/1/uuid.wav',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
        id: 'huge-obj',
      } as any);

      const result = await service.initUpload(dto, testUserId);

      expect(result.totalParts).toBeLessThanOrEqual(10000);
      expect(result.partSize).toBeGreaterThan(10485760);
      // Rounded up to a whole MiB, always.
      expect(result.partSize % (1024 * 1024)).toBe(0);
      // Every byte is covered.
      expect(result.partSize * result.totalParts).toBeGreaterThanOrEqual(dto.size);
    });

    it('should slice a 5 GB file into no more than 10,000 parts', async () => {
      const dto = {
        name: 'interview.m4a',
        size: 5 * 1024 * 1024 * 1024,
        mimeType: 'audio/mp4',
      };

      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-5gb',
        key: 'uploads/1/uuid.m4a',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
        id: 'five-gb',
      } as any);

      const result = await service.initUpload(dto, testUserId);

      expect(result.totalParts).toBeLessThanOrEqual(10000);
      // 5 GiB at the configured 10 MiB is 512 parts — well inside the limit,
      // so the configured size is used unchanged.
      expect(result.partSize).toBe(10485760);
      expect(result.totalParts).toBe(512);
      // The first batch is a fast path, not the whole upload.
      expect(result.presignedUrls).toHaveLength(10);
    });

    it('should persist the part size it chose', async () => {
      const dto = {
        name: 'recording.m4a',
        size: 5 * 1024 * 1024 * 1024,
        mimeType: 'audio/mp4',
      };

      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-persist',
        key: 'uploads/1/uuid.m4a',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
      } as any);

      await service.initUpload(dto, testUserId);

      expect(mockPrisma.storageObject.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ partSize: 10485760, managedBy: null }),
        }),
      );
    });

    it('should reject a file larger than storage.maxFileSize, naming the limit', async () => {
      configValues['storage.maxFileSize'] = 104857600; // 100 MiB

      const dto = {
        name: 'too-big.mp3',
        size: 209715200, // 200 MiB
        mimeType: 'audio/mpeg',
      };

      await expect(service.initUpload(dto, testUserId)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.initUpload(dto, testUserId)).rejects.toThrow(
        /maximum upload size of 100\.0 MB \(104857600 bytes\)/,
      );
      expect(mockStorageProvider.initMultipartUpload).not.toHaveBeenCalled();
    });

    it('should reject a disallowed MIME type, naming the type', async () => {
      configValues['storage.allowedMimeTypes'] = ['audio/*'];

      const dto = {
        name: 'sheet.xlsx',
        size: 1024,
        mimeType: 'application/vnd.ms-excel',
      };

      await expect(service.initUpload(dto, testUserId)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.initUpload(dto, testUserId)).rejects.toThrow(
        /application\/vnd\.ms-excel/,
      );
      expect(mockStorageProvider.initMultipartUpload).not.toHaveBeenCalled();
    });

    it('should accept a family wildcard in the allowlist', async () => {
      configValues['storage.allowedMimeTypes'] = ['audio/*'];

      const dto = { name: 'a.flac', size: 1024, mimeType: 'audio/flac' };

      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'u',
        key: 'k',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
      } as any);

      await expect(service.initUpload(dto, testUserId)).resolves.toBeDefined();
    });

    // A phone recording arrives typeless. Rejecting it is rejecting the
    // ordinary case, which is why the extension gets a say.
    it.each([
      ['application/octet-stream', 'memo.m4a', 'audio/mp4'],
      ['', 'memo.amr', 'audio/amr'],
      [undefined, 'memo.mp3', 'audio/mpeg'],
      ['application/octet-stream', 'memo.OPUS', 'audio/opus'],
    ])(
      'should accept %p for %s and store it as %s',
      async (declared, name, expected) => {
        configValues['storage.allowedMimeTypes'] = ['audio/*'];

        mockStorageProvider.initMultipartUpload.mockResolvedValue({
          uploadId: 'u',
          key: 'k',
        });
        mockStorageProvider.getBucket.mockReturnValue('test-bucket');
        mockPrisma.storageObject.create.mockResolvedValue({
          ...mockStorageObject,
        } as any);

        await service.initUpload(
          { name, size: 1024, mimeType: declared as string | undefined },
          testUserId,
        );

        // Stored as the resolved type, not as octet-stream: an object stored
        // with a generic content type is one a browser refuses to play.
        expect(mockPrisma.storageObject.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ mimeType: expected }),
          }),
        );
        expect(mockStorageProvider.initMultipartUpload).toHaveBeenCalledWith(
          expect.any(String),
          { mimeType: expected },
        );
      },
    );

    it('should reject a generic MIME type with no audio extension to rescue it', async () => {
      configValues['storage.allowedMimeTypes'] = ['audio/*'];

      const dto = {
        name: 'mystery.bin',
        size: 1024,
        mimeType: 'application/octet-stream',
      };

      await expect(service.initUpload(dto, testUserId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should persist managedBy when a module claims the object', async () => {
      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'u',
        key: 'k',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
      } as any);

      await service.initUpload(
        { name: 'src.m4a', size: 1024, mimeType: 'audio/mp4' },
        testUserId,
        'transcripts',
      );

      expect(mockPrisma.storageObject.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ managedBy: 'transcripts' }),
        }),
      );
    });

    it('should call storage provider initMultipartUpload', async () => {
      const dto = {
        name: 'test.pdf',
        size: 10485760,
        mimeType: 'application/pdf',
      };

      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-123',
        key: 'test-key',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
      } as any);

      await service.initUpload(dto, testUserId);

      expect(mockStorageProvider.initMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^uploads\//),
        expect.objectContaining({
          mimeType: dto.mimeType,
        }),
      );
    });
  });

  describe('getUploadStatus', () => {
    // ⚠ THE PROVIDER IS THE SOURCE, NOT `storage_object_chunks` (#21). Those
    // rows are written by `completeUpload`, so a status built from them
    // reported 0 of N for the whole life of an upload and N of N once resuming
    // was pointless — which is to say resume never worked at all.
    it('should build progress from the provider, not from chunk rows', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        status: 'uploading',
        s3UploadId: 'upload-123',
        partSize: 10485760,
        size: BigInt(26214400), // 25 MiB -> 3 parts
        // Deliberately present and deliberately WRONG: if the service reads
        // these, the expectations below fail.
        chunks: [{ partNumber: 9, size: BigInt(1), eTag: 'stale' }],
      } as any);
      mockStorageProvider.listParts.mockResolvedValue([
        { partNumber: 1, size: 10485760, etag: 'etag1' },
        { partNumber: 3, size: 5242880, etag: 'etag3' },
      ]);
      mockPrisma.storageObject.update.mockResolvedValue({} as any);

      const result = await service.getUploadStatus(mockStorageObject.id, testUserId);

      expect(mockStorageProvider.listParts).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
        'upload-123',
      );
      expect(result.objectId).toBe(mockStorageObject.id);
      expect(result.status).toBe('uploading');
      // Part 2 is genuinely missing — that is what a resuming client needs.
      expect(result.uploadedParts).toEqual([1, 3]);
      expect(result.totalParts).toBe(3);
      expect(result.partSize).toBe(10485760);
      expect(result.uploadedBytes).toBe('15728640');
      expect(result.totalBytes).toBe('26214400');
    });

    it('should report the persisted part size, not the currently configured one', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        status: 'uploading',
        s3UploadId: 'upload-123',
        partSize: 8388608, // 8 MiB, what this upload was started with
        size: BigInt(41943040), // 40 MiB -> 5 parts at 8 MiB, 4 at 10 MiB
        chunks: [],
      } as any);
      mockStorageProvider.listParts.mockResolvedValue([]);
      mockPrisma.storageObject.update.mockResolvedValue({} as any);

      // The deployment has since been reconfigured. It must not renumber an
      // upload already in flight.
      configValues['storage.partSize'] = 10485760;

      const result = await service.getUploadStatus(mockStorageObject.id, testUserId);

      expect(result.partSize).toBe(8388608);
      expect(result.totalParts).toBe(5);
    });

    it('should refresh the activity timestamp so the stale sweep leaves it alone', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        status: 'uploading',
        s3UploadId: 'upload-123',
        chunks: [],
      } as any);
      mockStorageProvider.listParts.mockResolvedValue([]);
      mockPrisma.storageObject.update.mockResolvedValue({} as any);

      await service.getUploadStatus(mockStorageObject.id, testUserId);

      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
        data: { updatedAt: expect.any(Date) },
      });
    });

    it('should not ask the provider about an upload that already completed', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        status: 'ready',
        s3UploadId: null,
        size: BigInt(20971520), // 20 MiB -> 2 parts
      } as any);

      const result = await service.getUploadStatus(mockStorageObject.id, testUserId);

      expect(mockStorageProvider.listParts).not.toHaveBeenCalled();
      expect(result.uploadedParts).toEqual([1, 2]);
      expect(result.uploadedBytes).toBe('20971520');
      // A read must not rewrite "when this object last changed".
      expect(mockPrisma.storageObject.update).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException for non-existent object', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(
        service.getUploadStatus('non-existent', testUserId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.getUploadStatus('non-existent', testUserId),
      ).rejects.toThrow('Upload not found');
    });

    it('should throw ForbiddenException for non-owner', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: otherUserId,
        chunks: [],
      } as any);

      await expect(
        service.getUploadStatus(mockStorageObject.id, testUserId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.getUploadStatus(mockStorageObject.id, testUserId),
      ).rejects.toThrow('You do not own this upload');
    });
  });

  // ===========================================================================
  // presignParts (#21) — the endpoint that makes an upload bigger than the
  // first batch possible at all.
  // ===========================================================================
  describe('presignParts', () => {
    const activeUpload = {
      status: 'uploading',
      s3UploadId: 'upload-123',
      partSize: 10485760,
      size: BigInt(10485760 * 20), // 20 parts
    };

    beforeEach(() => {
      mockPrisma.storageObject.update.mockResolvedValue({} as any);
      mockStorageProvider.getSignedUploadUrl.mockImplementation(
        async (_key: string, _uploadId: string, partNumber: number) =>
          `https://signed.example/part/${partNumber}`,
      );
    });

    it('should sign every requested part and report when the URLs expire', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        ...activeUpload,
      } as any);

      const result = await service.presignParts(testUserId, mockStorageObject.id, [
        11, 12, 13,
      ]);

      expect(result).toHaveLength(3);
      expect(result.map((part) => part.partNumber)).toEqual([11, 12, 13]);
      expect(result[0].url).toBe('https://signed.example/part/11');
      expect(new Date(result[0].expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(mockStorageProvider.getSignedUploadUrl).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
        'upload-123',
        11,
        3600,
      );
    });

    it('should refresh the activity timestamp so the sweep leaves it alone', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        ...activeUpload,
      } as any);

      await service.presignParts(testUserId, mockStorageObject.id, [2]);

      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
        data: { updatedAt: expect.any(Date) },
      });
    });

    it('should reject a batch larger than 100 part numbers', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        ...activeUpload,
        size: BigInt(10485760 * 200),
      } as any);

      const partNumbers = Array.from({ length: 101 }, (_, i) => i + 1);

      await expect(
        service.presignParts(testUserId, mockStorageObject.id, partNumbers),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.presignParts(testUserId, mockStorageObject.id, partNumbers),
      ).rejects.toThrow('At most 100 part numbers');
    });

    it('should reject an empty batch', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        ...activeUpload,
      } as any);

      await expect(
        service.presignParts(testUserId, mockStorageObject.id, []),
      ).rejects.toThrow(BadRequestException);
    });

    it.each([[0], [-1], [21], [1.5], [Number.NaN]])(
      'should reject part number %p as out of range',
      async (partNumber) => {
        mockPrisma.storageObject.findUnique.mockResolvedValue({
          ...mockStorageObject,
          ...activeUpload,
        } as any);

        await expect(
          service.presignParts(testUserId, mockStorageObject.id, [partNumber]),
        ).rejects.toThrow(BadRequestException);
        expect(mockStorageProvider.getSignedUploadUrl).not.toHaveBeenCalled();
      },
    );

    it('should reject duplicate part numbers', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        ...activeUpload,
      } as any);

      await expect(
        service.presignParts(testUserId, mockStorageObject.id, [3, 4, 3]),
      ).rejects.toThrow('requested more than once');
    });

    it.each([['ready'], ['processing'], ['failed']])(
      'should refuse to sign parts for a %s upload',
      async (status) => {
        mockPrisma.storageObject.findUnique.mockResolvedValue({
          ...mockStorageObject,
          ...activeUpload,
          status,
        } as any);

        await expect(
          service.presignParts(testUserId, mockStorageObject.id, [1]),
        ).rejects.toThrow('no longer in progress');
      },
    );

    it('should refuse to sign parts when there is no multipart upload', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        ...activeUpload,
        s3UploadId: null,
      } as any);

      await expect(
        service.presignParts(testUserId, mockStorageObject.id, [1]),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ForbiddenException for a non-owner', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        ...activeUpload,
        uploadedById: otherUserId,
      } as any);

      await expect(
        service.presignParts(testUserId, mockStorageObject.id, [1]),
      ).rejects.toThrow(ForbiddenException);
      expect(mockStorageProvider.getSignedUploadUrl).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException for an unknown upload', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(
        service.presignParts(testUserId, 'nope', [1]),
      ).rejects.toThrow(NotFoundException);
    });

    it('should range-check against the persisted part size, not the configured one', async () => {
      // 40 MiB at the upload's own 8 MiB parts is 5 parts; at the currently
      // configured 10 MiB it would be 4, and part 5 would be wrongly rejected.
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        ...activeUpload,
        partSize: 8388608,
        size: BigInt(41943040),
      } as any);
      configValues['storage.partSize'] = 10485760;

      await expect(
        service.presignParts(testUserId, mockStorageObject.id, [5]),
      ).resolves.toHaveLength(1);
    });
  });

  describe('completeUpload', () => {
    it('should complete multipart upload and update status', async () => {
      const dto = {
        parts: [
          { partNumber: 1, eTag: 'etag1' },
          { partNumber: 2, eTag: 'etag2' },
        ],
      };

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        status: 'pending',
        s3UploadId: 'upload-123',
        chunks: [],
      } as any);
      mockPrisma.storageObjectChunk.upsert.mockResolvedValue({} as any);
      mockStorageProvider.completeMultipartUpload.mockResolvedValue({
        key: mockStorageObject.storageKey,
        bucket: 'test-bucket',
        location: 's3://test-bucket/key',
        eTag: 'final-etag',
      });
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'processing',
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.completeUpload(
        mockStorageObject.id,
        dto,
        testUserId,
      );

      expect(result.status).toBe('processing');
      expect(mockStorageProvider.completeMultipartUpload).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
        'upload-123',
        dto.parts,
      );
      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
        data: { status: 'processing' },
      });
    });

    it('should emit ObjectUploadedEvent', async () => {
      const dto = {
        parts: [{ partNumber: 1, eTag: 'etag1' }],
      };

      const updatedObject = {
        ...mockStorageObject,
        status: 'processing',
      };

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: 'upload-123',
        chunks: [],
      } as any);
      mockPrisma.storageObjectChunk.upsert.mockResolvedValue({} as any);
      mockStorageProvider.completeMultipartUpload.mockResolvedValue({
        key: 'key',
        bucket: 'bucket',
        location: 's3://bucket/key',
      });
      mockPrisma.storageObject.update.mockResolvedValue(updatedObject as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.completeUpload(mockStorageObject.id, dto, testUserId);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        OBJECT_UPLOADED_EVENT,
        expect.objectContaining({
          object: updatedObject,
        }),
      );
    });

    it('should create audit event', async () => {
      const dto = {
        parts: [{ partNumber: 1, eTag: 'etag1' }],
      };

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: 'upload-123',
        chunks: [],
      } as any);
      mockPrisma.storageObjectChunk.upsert.mockResolvedValue({} as any);
      mockStorageProvider.completeMultipartUpload.mockResolvedValue({
        key: 'key',
        bucket: 'bucket',
        location: 's3://bucket/key',
      });
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'processing',
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.completeUpload(mockStorageObject.id, dto, testUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: testUserId,
          action: 'storage:upload:complete',
          targetType: 'storage_object',
          targetId: mockStorageObject.id,
          meta: expect.objectContaining({
            partsCount: 1,
          }),
        }),
      });
    });

    it('should throw NotFoundException for non-existent object', async () => {
      const dto = {
        parts: [{ partNumber: 1, eTag: 'etag1' }],
      };

      mockPrisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(
        service.completeUpload('non-existent', dto, testUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for non-owner', async () => {
      const dto = {
        parts: [{ partNumber: 1, eTag: 'etag1' }],
      };

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: otherUserId,
        s3UploadId: 'upload-123',
        chunks: [],
      } as any);

      await expect(
        service.completeUpload(mockStorageObject.id, dto, testUserId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException when uploadId is missing', async () => {
      const dto = {
        parts: [{ partNumber: 1, eTag: 'etag1' }],
      };

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: null,
        chunks: [],
      } as any);

      await expect(
        service.completeUpload(mockStorageObject.id, dto, testUserId),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.completeUpload(mockStorageObject.id, dto, testUserId),
      ).rejects.toThrow('Upload ID not found');
    });

    // ⚠ THE BROWSER PATH (#21). A page cannot read the ETag of a cross-origin
    // PUT unless the bucket exposes the header, so a client that gets the CORS
    // rule slightly wrong completes the upload with null ETags and corrupts
    // the object. Omitting `parts` makes that impossible.
    it('should build the parts list from the provider when parts are omitted', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: 'upload-123',
      } as any);
      mockStorageProvider.listParts.mockResolvedValue([
        { partNumber: 2, size: 10485760, etag: 'etag2' },
        { partNumber: 1, size: 10485760, etag: 'etag1' },
        { partNumber: 3, size: 512, etag: 'etag3' },
      ]);
      mockPrisma.storageObjectChunk.upsert.mockResolvedValue({} as any);
      mockStorageProvider.completeMultipartUpload.mockResolvedValue({
        key: 'k',
        bucket: 'b',
        location: 's3://b/k',
      });
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'processing',
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.completeUpload(mockStorageObject.id, {}, testUserId);

      // Sorted ascending — CompleteMultipartUpload rejects an out-of-order list.
      expect(mockStorageProvider.completeMultipartUpload).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
        'upload-123',
        [
          { partNumber: 1, eTag: 'etag1' },
          { partNumber: 2, eTag: 'etag2' },
          { partNumber: 3, eTag: 'etag3' },
        ],
      );
    });

    it('should not ask the provider when the caller supplied the parts', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: 'upload-123',
      } as any);
      mockPrisma.storageObjectChunk.upsert.mockResolvedValue({} as any);
      mockStorageProvider.completeMultipartUpload.mockResolvedValue({
        key: 'k',
        bucket: 'b',
        location: 's3://b/k',
      });
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'processing',
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.completeUpload(
        mockStorageObject.id,
        { parts: [{ partNumber: 1, eTag: 'client-etag' }] },
        testUserId,
      );

      expect(mockStorageProvider.listParts).not.toHaveBeenCalled();
    });

    it('should refuse to complete an upload the provider holds no parts for', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: 'upload-123',
      } as any);
      mockStorageProvider.listParts.mockResolvedValue([]);

      await expect(
        service.completeUpload(mockStorageObject.id, {}, testUserId),
      ).rejects.toThrow(BadRequestException);
      expect(mockStorageProvider.completeMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('abortUpload', () => {
    it('should abort upload and delete records', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: 'upload-123',
      } as any);
      mockStorageProvider.abortMultipartUpload.mockResolvedValue(undefined);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.abortUpload(mockStorageObject.id, testUserId);

      expect(mockStorageProvider.abortMultipartUpload).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
        'upload-123',
      );
      expect(mockPrisma.storageObject.delete).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
      });
    });

    it('should call storage provider abortMultipartUpload', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: 'upload-123',
      } as any);
      mockStorageProvider.abortMultipartUpload.mockResolvedValue(undefined);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.abortUpload(mockStorageObject.id, testUserId);

      expect(mockStorageProvider.abortMultipartUpload).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
        'upload-123',
      );
    });

    it('should create audit event', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: 'upload-123',
      } as any);
      mockStorageProvider.abortMultipartUpload.mockResolvedValue(undefined);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.abortUpload(mockStorageObject.id, testUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: testUserId,
          action: 'storage:upload:abort',
          targetType: 'storage_object',
          targetId: mockStorageObject.id,
        }),
      });
    });

    it('should throw NotFoundException for non-existent object', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(
        service.abortUpload('non-existent', testUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for non-owner', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: otherUserId,
        s3UploadId: 'upload-123',
      } as any);

      await expect(
        service.abortUpload(mockStorageObject.id, testUserId),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('simpleUpload', () => {
    it('should upload file and create record', async () => {
      const file = {
        filename: 'test.txt',
        mimetype: 'text/plain',
        file: Readable.from(['test content']),
      };

      mockStorageProvider.upload.mockResolvedValue({
        key: 'uploads/123/uuid.txt',
        bucket: 'test-bucket',
        location: 's3://test-bucket/uploads/123/uuid.txt',
        eTag: 'etag123',
      });
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
        name: file.filename,
        mimeType: file.mimetype,
        status: 'processing',
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.simpleUpload(file, testUserId);

      expect(result.name).toBe(file.filename);
      expect(result.mimeType).toBe(file.mimetype);
      expect(result.status).toBe('processing');
      expect(mockStorageProvider.upload).toHaveBeenCalled();
    });

    it('should emit ObjectUploadedEvent', async () => {
      const file = {
        filename: 'test.txt',
        mimetype: 'text/plain',
        file: Readable.from(['test content']),
      };

      const createdObject = {
        ...mockStorageObject,
        status: 'processing',
      };

      mockStorageProvider.upload.mockResolvedValue({
        key: 'key',
        bucket: 'bucket',
        location: 's3://bucket/key',
      });
      mockPrisma.storageObject.create.mockResolvedValue(createdObject as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.simpleUpload(file, testUserId);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        OBJECT_UPLOADED_EVENT,
        expect.objectContaining({
          object: createdObject,
        }),
      );
    });

    it('should create audit event', async () => {
      const file = {
        filename: 'test.txt',
        mimetype: 'text/plain',
        file: Readable.from(['test content']),
      };

      mockStorageProvider.upload.mockResolvedValue({
        key: 'key',
        bucket: 'bucket',
        location: 's3://bucket/key',
      });
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
        id: 'new-id',
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.simpleUpload(file, testUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: testUserId,
          action: 'storage:upload:complete',
          targetType: 'storage_object',
          targetId: 'new-id',
          meta: expect.objectContaining({
            uploadType: 'simple',
          }),
        }),
      });
    });
  });

  describe('list', () => {
    it('should return paginated results', async () => {
      const query = {
        page: 1,
        pageSize: 20,
        sortBy: 'createdAt' as const,
        sortOrder: 'desc' as const,
      };

      const mockObjects = [
        { ...mockStorageObject, id: 'obj-1' },
        { ...mockStorageObject, id: 'obj-2' },
      ];

      mockPrisma.storageObject.findMany.mockResolvedValue(mockObjects as any);
      mockPrisma.storageObject.count.mockResolvedValue(2);

      const result = await service.list(query, testUserId);

      expect(result.items).toHaveLength(2);
      expect(result.meta.page).toBe(1);
      expect(result.meta.pageSize).toBe(20);
      expect(result.meta.totalItems).toBe(2);
      expect(result.meta.totalPages).toBe(1);
    });

    it('should filter by status', async () => {
      const query = {
        page: 1,
        pageSize: 20,
        status: 'ready' as const,
        sortBy: 'createdAt' as const,
        sortOrder: 'desc' as const,
      };

      mockPrisma.storageObject.findMany.mockResolvedValue([mockStorageObject] as any);
      mockPrisma.storageObject.count.mockResolvedValue(1);

      await service.list(query, testUserId);

      expect(mockPrisma.storageObject.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'ready',
          }),
        }),
      );
    });

    it('should sort by specified field', async () => {
      const query = {
        page: 1,
        pageSize: 20,
        sortBy: 'name' as const,
        sortOrder: 'asc' as const,
      };

      mockPrisma.storageObject.findMany.mockResolvedValue([]);
      mockPrisma.storageObject.count.mockResolvedValue(0);

      await service.list(query, testUserId);

      expect(mockPrisma.storageObject.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { name: 'asc' },
        }),
      );
    });
  });

  // ===========================================================================
  // Managed objects (#21) — owned by another module, so the generic list and
  // delete must not act on them.
  // ===========================================================================
  describe('managed objects', () => {
    it('should exclude managed objects from the list query', async () => {
      mockPrisma.storageObject.findMany.mockResolvedValue([]);
      mockPrisma.storageObject.count.mockResolvedValue(0);

      await service.list(
        {
          page: 1,
          pageSize: 20,
          sortBy: 'createdAt' as const,
          sortOrder: 'desc' as const,
        },
        testUserId,
      );

      expect(mockPrisma.storageObject.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            uploadedById: testUserId,
            managedBy: null,
          }),
        }),
      );
      expect(mockPrisma.storageObject.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ managedBy: null }),
        }),
      );
    });

    it('should answer 409 on DELETE, naming the owning module', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        managedBy: 'transcripts',
      } as any);

      await expect(
        service.delete(mockStorageObject.id, testUserId),
      ).rejects.toThrow(ConflictException);
      await expect(
        service.delete(mockStorageObject.id, testUserId),
      ).rejects.toThrow('managed by the transcripts module');

      // Nothing was touched. A 409 that had already deleted the bytes would be
      // the worst of both answers.
      expect(mockStorageProvider.delete).not.toHaveBeenCalled();
      expect(mockPrisma.storageObject.delete).not.toHaveBeenCalled();
    });

    it('should let the owning module delete through deleteManagedObject', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        managedBy: 'transcripts',
      } as any);
      mockStorageProvider.delete.mockResolvedValue(undefined);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.deleteManagedObject(
        mockStorageObject.id,
        'transcripts',
        testUserId,
      );

      expect(mockStorageProvider.delete).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
      );
      expect(mockPrisma.storageObject.delete).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
      });
    });

    it('should refuse to let one module delete another module\'s object', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        managedBy: 'transcripts',
      } as any);

      await expect(
        service.deleteManagedObject(mockStorageObject.id, 'exports'),
      ).rejects.toThrow(ConflictException);
      expect(mockStorageProvider.delete).not.toHaveBeenCalled();
    });

    // The owner still owns the bytes. Only list and delete change.
    it('should keep get, download and metadata reachable by the owner', async () => {
      const managed = { ...mockStorageObject, managedBy: 'transcripts' };

      mockPrisma.storageObject.findUnique.mockResolvedValue(managed as any);
      mockStorageProvider.getSignedDownloadUrl.mockResolvedValue('https://s/d');
      mockPrisma.storageObject.update.mockResolvedValue(managed as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await expect(
        service.getById(mockStorageObject.id, testUserId),
      ).resolves.toMatchObject({ id: mockStorageObject.id });
      await expect(
        service.getDownloadUrl(mockStorageObject.id, testUserId),
      ).resolves.toMatchObject({ url: 'https://s/d' });
      await expect(
        service.updateMetadata(
          mockStorageObject.id,
          { metadata: { a: 1 } },
          testUserId,
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('getById', () => {
    it('should return object metadata', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(mockStorageObject as any);

      const result = await service.getById(mockStorageObject.id, testUserId);

      expect(result.id).toBe(mockStorageObject.id);
      expect(result.name).toBe(mockStorageObject.name);
    });

    it('should throw NotFoundException for non-existent object', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(service.getById('non-existent', testUserId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException for non-owner', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: otherUserId,
      } as any);

      await expect(
        service.getById(mockStorageObject.id, testUserId),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getDownloadUrl', () => {
    it('should return signed URL for ready objects', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        status: 'ready',
      } as any);
      mockStorageProvider.getSignedDownloadUrl.mockResolvedValue(
        'https://signed-url.com/download',
      );

      const result = await service.getDownloadUrl(mockStorageObject.id, testUserId);

      expect(result.url).toBe('https://signed-url.com/download');
      expect(result.expiresIn).toBe(3600);
      expect(mockStorageProvider.getSignedDownloadUrl).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
        { expiresIn: 3600 },
      );
    });

    it('should throw BadRequestException for non-ready objects', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        status: 'processing',
      } as any);

      await expect(
        service.getDownloadUrl(mockStorageObject.id, testUserId),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.getDownloadUrl(mockStorageObject.id, testUserId),
      ).rejects.toThrow('Object is not ready for download');
    });
  });

  describe('delete', () => {
    it('should delete from storage and database', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(mockStorageObject as any);
      mockStorageProvider.delete.mockResolvedValue(undefined);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.delete(mockStorageObject.id, testUserId);

      expect(mockStorageProvider.delete).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
      );
      expect(mockPrisma.storageObject.delete).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
      });
    });

    it('should create audit event', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(mockStorageObject as any);
      mockStorageProvider.delete.mockResolvedValue(undefined);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.delete(mockStorageObject.id, testUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: testUserId,
          action: 'storage:object:delete',
          targetType: 'storage_object',
          targetId: mockStorageObject.id,
        }),
      });
    });
  });

  describe('updateMetadata', () => {
    it('should merge metadata and update record', async () => {
      const existingMetadata = { key1: 'value1' };
      const newMetadata = { key2: 'value2' };

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        metadata: existingMetadata,
      } as any);
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        metadata: { ...existingMetadata, ...newMetadata },
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.updateMetadata(
        mockStorageObject.id,
        { metadata: newMetadata },
        testUserId,
      );

      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
        data: {
          metadata: { ...existingMetadata, ...newMetadata },
        },
      });
    });

    it('should create audit event', async () => {
      const newMetadata = { key: 'value' };

      mockPrisma.storageObject.findUnique.mockResolvedValue(mockStorageObject as any);
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        metadata: newMetadata,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.updateMetadata(
        mockStorageObject.id,
        { metadata: newMetadata },
        testUserId,
      );

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: testUserId,
          action: 'storage:object:metadata:update',
          targetType: 'storage_object',
          targetId: mockStorageObject.id,
        }),
      });
    });
  });
});

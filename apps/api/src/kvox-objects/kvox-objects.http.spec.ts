// =============================================================================
// Mocked HTTP integration: KVox's storage routes on a real Fastify app (#469)
// =============================================================================
//
// The two controllers, the delete hook and a stand-in for the PLATFORM's
// `DELETE /api/storage/objects/:id` handler, on a real Fastify instance with the
// `api` global prefix. The identity guards are replaced by one that reads a test
// header, and the services behind the controllers are fakes, so what is under
// test is the wiring: the paths, the status codes, the hook running BEFORE the
// platform handler, and the 404-never-403 rule. The full-application variants
// (platform handlers, real guards) are the testing agent's
// `test/kvox-objects/*.integration.spec.ts`.
// =============================================================================

import 'reflect-metadata';
import { Controller, Delete, HttpCode, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  JwtAuthGuard,
  PermissionsGuard,
  RolesGuard,
} from '@marinoscar/platform-api/identity';
import { STORAGE_OPTIONS, STORAGE_PROVIDER } from '@marinoscar/platform-api/storage';

import { KvoxFilesController } from './kvox-files.controller';
import { KvoxManagedObjectsService } from './kvox-managed-objects.service';
import { KvoxMultipartController } from './kvox-multipart.controller';
import { KvoxS3PartLister } from './kvox-s3-part-lister';
import { ManagedDeleteVeto, installManagedDeleteHook } from './managed-delete.hook';
import { KvoxObjectOwnershipStore } from './kvox-object-ownership.store';
import { PrismaService } from '../prisma/prisma.service';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const UPLOAD = '44444444-4444-4444-8444-444444444444';
const MANAGED = '55555555-5555-4555-8555-555555555555';
const PLAIN = '66666666-6666-4666-8666-666666666666';
const MIB = 1024 * 1024;

/** Stands in for the platform's objects controller: reaching it means the veto let the call through. */
const platformDelete = jest.fn();

@Controller('storage/objects')
class PlatformDeleteStandIn {
  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string): void {
    platformDelete(id);
  }
}

/** Reads the caller from `x-test-user`; no header is the platform guard's 401. */
const testGuard = {
  canActivate(context: { switchToHttp(): { getRequest(): { headers: Record<string, string>; user?: unknown } } }) {
    const request = context.switchToHttp().getRequest();
    const user = request.headers['x-test-user'];
    if (!user) return false;
    request.user = { id: user, activeOrgId: ORG };
    return true;
  },
};

function uploadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: UPLOAD,
    uploadedById: ALICE,
    storageKey: 'uploads/org/1/abc.m4a',
    s3UploadId: 'upload-1',
    status: 'uploading',
    size: BigInt(1500 * MIB), // 150 parts at 10 MiB
    ...overrides,
  };
}

describe('KVox storage routes (mocked HTTP)', () => {
  let app: NestFastifyApplication;
  let managed: { get: jest.Mock; run: jest.Mock };
  let lister: { listParts: jest.Mock };
  let ownership: { managedBy: jest.Mock };
  let findMany: jest.Mock;
  let count: jest.Mock;

  beforeAll(async () => {
    managed = { get: jest.fn(), run: jest.fn() };
    lister = { listParts: jest.fn() };
    ownership = { managedBy: jest.fn() };
    findMany = jest.fn();
    count = jest.fn();

    const moduleRef = await Test.createTestingModule({
      controllers: [PlatformDeleteStandIn, KvoxMultipartController, KvoxFilesController],
      providers: [
        { provide: KvoxManagedObjectsService, useValue: managed },
        { provide: KvoxS3PartLister, useValue: lister },
        { provide: KvoxObjectOwnershipStore, useValue: ownership },
        { provide: PrismaService, useValue: {} },
        ManagedDeleteVeto,
        { provide: ConfigService, useValue: { get: (_key: string, fallback: number) => fallback } },
        {
          provide: STORAGE_PROVIDER,
          useValue: {
            getSignedUploadUrl: async (_key: string, _id: string, partNumber: number) => `https://s3.test/p/${partNumber}`,
          },
        },
        { provide: STORAGE_OPTIONS, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(testGuard)
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    installManagedDeleteHook(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    managed.get.mockResolvedValue(uploadRow());
    managed.run.mockImplementation(async (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ storageObject: { findMany, count } }),
    );
    lister.listParts.mockResolvedValue([{ partNumber: 1, etag: '"a"', size: 10 * MIB }]);
    ownership.managedBy.mockImplementation(async (_tx: unknown, ids: string[]) =>
      new Map(ids.filter((id) => id === MANAGED).map((id) => [id, 'transcripts'])),
    );
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);
  });

  const asAlice = { 'x-test-user': ALICE, authorization: 'Bearer t' };
  const asBob = { 'x-test-user': BOB, authorization: 'Bearer t' };

  describe('POST /api/storage/objects/:id/upload/parts', () => {
    it('signs parts 11-110 (past the platform\'s first ten) for the uploader', async () => {
      const partNumbers = Array.from({ length: 110 - 10 }, (_, i) => i + 11); // 11..110, one full batch
      const response = await app.inject({
        method: 'POST',
        url: `/api/storage/objects/${UPLOAD}/upload/parts`,
        headers: asAlice,
        payload: { partNumbers },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: Array<{ partNumber: number; url: string }> };
      expect(body.data).toHaveLength(100);
      expect(body.data[0]).toEqual({ partNumber: 11, url: 'https://s3.test/p/11' });
    });

    it('answers 404 for another user\'s object, never 403', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/storage/objects/${UPLOAD}/upload/parts`,
        headers: asBob,
        payload: { partNumbers: [11] },
      });
      expect(response.statusCode).toBe(404);
    });

    it('answers 400 for more than 100 part numbers and for duplicates', async () => {
      const tooMany = await app.inject({
        method: 'POST',
        url: `/api/storage/objects/${UPLOAD}/upload/parts`,
        headers: asAlice,
        payload: { partNumbers: Array.from({ length: 101 }, (_, i) => i + 1) },
      });
      expect(tooMany.statusCode).toBe(400);

      const duplicate = await app.inject({
        method: 'POST',
        url: `/api/storage/objects/${UPLOAD}/upload/parts`,
        headers: asAlice,
        payload: { partNumbers: [5, 5] },
      });
      expect(duplicate.statusCode).toBe(400);
    });

    it('is refused without credentials', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/storage/objects/${UPLOAD}/upload/parts`,
        payload: { partNumbers: [1] },
      });
      expect(response.statusCode).toBe(403); // the stand-in guard's `false`; the real guard answers 401
    });
  });

  describe('GET /api/storage/objects/:id/upload/parts', () => {
    it('lists the provider\'s parts', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/storage/objects/${UPLOAD}/upload/parts`, headers: asAlice });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: [{ partNumber: 1, etag: '"a"', size: 10 * MIB }] });
    });

    it('answers 404 for another user\'s object', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/storage/objects/${UPLOAD}/upload/parts`, headers: asBob });
      expect(response.statusCode).toBe(404);
      expect(lister.listParts).not.toHaveBeenCalled();
    });

    it('answers 501 list_parts_unsupported for a non-S3 driver', async () => {
      const { NotImplementedException } = jest.requireActual('@nestjs/common');
      lister.listParts.mockRejectedValue(
        new NotImplementedException({ message: 'unsupported', details: { reason: 'list_parts_unsupported' } }),
      );

      const response = await app.inject({ method: 'GET', url: `/api/storage/objects/${UPLOAD}/upload/parts`, headers: asAlice });

      expect(response.statusCode).toBe(501);
      expect(response.json()).toMatchObject({ details: { reason: 'list_parts_unsupported' } });
    });
  });

  describe('GET /api/kvox/files', () => {
    it('lists through the unmanaged predicate in the caller\'s organization', async () => {
      findMany.mockResolvedValue([
        {
          id: PLAIN,
          name: 'plain.m4a',
          size: BigInt(10),
          mimeType: 'audio/mp4',
          status: 'ready',
          metadata: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);
      count.mockResolvedValue(1);

      const response = await app.inject({ method: 'GET', url: '/api/kvox/files?pageSize=5', headers: asAlice });

      expect(response.statusCode).toBe(200);
      expect(managed.run).toHaveBeenCalledWith({ orgId: ORG }, expect.any(Function));
      expect(findMany.mock.calls[0][0]).toMatchObject({
        where: { uploadedById: ALICE, kvoxOwnership: { is: null } },
        take: 5,
      });
      expect(response.json()).toMatchObject({
        data: { items: [{ id: PLAIN, size: '10' }], meta: { page: 1, pageSize: 5, totalItems: 1, totalPages: 1 } },
      });
    });

    it('rejects an invalid query', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/kvox/files?pageSize=1000', headers: asAlice });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/storage/objects/:id (the veto)', () => {
    it('answers 409 managed_by_module before the platform handler runs', async () => {
      const response = await app.inject({ method: 'DELETE', url: `/api/storage/objects/${MANAGED}`, headers: asAlice });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'CONFLICT', details: { reason: 'managed_by_module', module: 'transcripts' } });
      expect(platformDelete).not.toHaveBeenCalled();
    });

    it('lets a plain upload reach the platform handler', async () => {
      const response = await app.inject({ method: 'DELETE', url: `/api/storage/objects/${PLAIN}`, headers: asAlice });

      expect(response.statusCode).toBe(204);
      expect(platformDelete).toHaveBeenCalledWith(PLAIN);
    });

    it('does not tell an anonymous caller which ids are managed', async () => {
      const response = await app.inject({ method: 'DELETE', url: `/api/storage/objects/${MANAGED}` });

      expect(response.statusCode).not.toBe(409);
      expect(ownership.managedBy).not.toHaveBeenCalled();
    });
  });
});

import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { CredentialsService } from '../../src/credentials/credentials.service';
import { STORAGE_PROVIDER } from '../../src/storage/providers/storage-provider.interface';
import { SHARE_LOOKUP_MAX_MISSES } from '../../src/transcripts/share-lookup-throttle.service';
import { SHARE_RECIPIENT_NOT_FOUND_MESSAGE } from '../../src/transcripts/transcript-sharing.service';
import { TRANSCRIPT_NOT_FOUND_MESSAGE } from '../../src/transcripts/transcript-access.service';

// =============================================================================
// Transcript sharing over the wire (issue #29, epic #19, spec §6.3)
// =============================================================================
//
// HTTP-level coverage for the parts of issue #29 that are about the WIRE rather
// than about a handler — the status codes and the response bodies a client
// actually meets:
//
//   * a NON-OWNER reading, granting or changing a share gets **404**, and the
//     SAME message a caller gets for a transcript that does not exist;
//   * an unknown address gets a **404** whose message names no address;
//   * a DEACTIVATED account is indistinguishable from an absent one;
//   * a run of misses gets **429**;
//   * an honest grant is **201** and a revoke is **204**;
//   * `DELETE` is reachable with `transcripts:read` alone, because "leave" must
//     not need a write permission on somebody else's recording.
//
// Everything except `PrismaService`, `CredentialsService` and the storage
// provider is what `AppModule` wires — the same boundary a production request
// crosses, including the global `ZodValidationPipe` and the guards.
//
// The RBAC MATRIX ITSELF — owner, editor, viewer and stranger across read,
// play, export, edit, restore, share, delete and leave — lives in
// `transcript-sharing.db.spec.ts`, against real rows: a matrix asserted over a
// mock whose `transcriptShare.findUnique` returns whatever the test just told
// it to would be asserting the test's own arrangement.
// =============================================================================

const TRANSCRIPTS = '/api/transcripts';
const TRANSCRIPT_ID = '11111111-2222-4333-8444-555555555555';
const RECIPIENT_ID = '22222222-3333-4444-8555-666666666666';

const transcriptRow = (overrides: Record<string, unknown> = {}) => ({
  id: TRANSCRIPT_ID,
  ownerId: 'owner-user-id',
  title: 'A recording',
  status: 'ready',
  transcriptionStatus: 'completed',
  playbackStatus: 'ready',
  language: 'en',
  durationMs: 120_000,
  speakerCount: 2,
  wordCount: 400,
  currentVersion: 3,
  failureReason: null,
  provider: 'assemblyai',
  providerJobId: 'remote-1',
  providerOptions: {},
  sourceObjectId: 'obj-source',
  playbackObjectId: 'obj-playback',
  rawResultObjectId: null,
  remoteDeletedAt: null,
  submittedAt: new Date('2026-01-01T00:00:00.000Z'),
  completedAt: new Date('2026-01-01T00:10:00.000Z'),
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:10:00.000Z'),
  ...overrides,
});

const shareRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'share-1',
  transcriptId: TRANSCRIPT_ID,
  userId: RECIPIENT_ID,
  role: 'viewer',
  grantedById: 'owner-user-id',
  createdAt: new Date('2026-01-02T00:00:00.000Z'),
  user: { email: 'colleague@example.test', displayName: 'A Colleague' },
  ...overrides,
});

describe('Transcript sharing integration', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        {
          provide: CredentialsService,
          useValue: {
            describe: jest.fn().mockResolvedValue({ name: 'assemblyai' }),
            getSecret: jest.fn().mockResolvedValue('aai-key'),
          },
        },
        {
          provide: STORAGE_PROVIDER,
          useValue: {
            getBucket: jest.fn().mockReturnValue('test-bucket'),
            getSignedDownloadUrl: jest.fn().mockResolvedValue('https://signed/get'),
          },
        },
      ],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();

    prismaMock.auditEvent.create.mockResolvedValue({} as never);
    prismaMock.transcriptShare.findUnique.mockResolvedValue(null as never);
    prismaMock.transcriptShare.findMany.mockResolvedValue([] as never);
  });

  /** An owner whose token authenticates and whose transcript exists. */
  async function owner() {
    const user = await createMockTestUser(context);

    prismaMock.transcript.findUnique.mockResolvedValue(
      transcriptRow({ ownerId: user.id }) as never,
    );

    return user;
  }

  // ==========================================================================
  // GET /:id/shares
  // ==========================================================================

  describe('GET /api/transcripts/:id/shares', () => {
    it('lists everyone the owner shared with', async () => {
      const user = await owner();

      prismaMock.transcriptShare.findMany.mockResolvedValue([shareRow()] as never);

      const response = await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.items).toEqual([
        {
          id: 'share-1',
          userId: RECIPIENT_ID,
          email: 'colleague@example.test',
          displayName: 'A Colleague',
          role: 'viewer',
          grantedById: 'owner-user-id',
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ]);
    });

    it('is 404 — not 403 — for a NON-OWNER, with the same message a missing transcript gets', async () => {
      const user = await createMockTestUser(context);

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: 'somebody-else' }) as never,
      );

      const response = await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(response.body.message).toBe(TRANSCRIPT_NOT_FOUND_MESSAGE);
    });

    it('is 404 for a transcript that does not exist, byte-identically', async () => {
      const user = await createMockTestUser(context);

      prismaMock.transcript.findUnique.mockResolvedValue(null as never);

      const response = await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(response.body.message).toBe(TRANSCRIPT_NOT_FOUND_MESSAGE);
    });
  });

  // ==========================================================================
  // POST /:id/shares
  // ==========================================================================

  describe('POST /api/transcripts/:id/shares', () => {
    it('grants the share and answers 201', async () => {
      const user = await owner();

      prismaMock.user.findFirst.mockResolvedValue({
        id: RECIPIENT_ID,
        email: 'colleague@example.test',
        displayName: 'A Colleague',
        isActive: true,
      } as never);
      prismaMock.transcriptShare.upsert.mockResolvedValue(shareRow({ role: 'editor' }) as never);

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
        .set(authHeader(user.accessToken))
        .send({ email: 'Colleague@Example.TEST', role: 'editor' })
        .expect(201);

      expect(response.body.data.role).toBe('editor');
      // NORMALISED AT THE EDGE: the DTO lowercases, so the lookup and the rate
      // limiter cannot disagree about what "the same address" means.
      expect(prismaMock.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: { equals: 'colleague@example.test', mode: 'insensitive' } },
        }),
      );
    });

    it('is 404 with a message that names NO address for an unknown one', async () => {
      const user = await owner();

      prismaMock.user.findFirst.mockResolvedValue(null as never);

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
        .set(authHeader(user.accessToken))
        .send({ email: 'nobody@example.test', role: 'viewer' })
        .expect(404);

      expect(response.body.message).toBe(SHARE_RECIPIENT_NOT_FOUND_MESSAGE);
      expect(response.body.message).not.toContain('nobody');
      expect(JSON.stringify(response.body)).not.toContain('nobody@example.test');
    });

    it('answers a DEACTIVATED account exactly as it answers an absent one', async () => {
      const user = await owner();

      prismaMock.user.findFirst.mockResolvedValue({
        id: RECIPIENT_ID,
        email: 'ex-colleague@example.test',
        displayName: null,
        isActive: false,
      } as never);

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
        .set(authHeader(user.accessToken))
        .send({ email: 'ex-colleague@example.test', role: 'viewer' })
        .expect(404);

      expect(response.body.message).toBe(SHARE_RECIPIENT_NOT_FOUND_MESSAGE);
      expect(prismaMock.transcriptShare.upsert).not.toHaveBeenCalled();
    });

    it('rate limits a run of misses with 429', async () => {
      const user = await owner();

      prismaMock.user.findFirst.mockResolvedValue(null as never);

      for (let index = 0; index < SHARE_LOOKUP_MAX_MISSES; index += 1) {
        await request(context.app.getHttpServer())
          .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
          .set(authHeader(user.accessToken))
          .send({ email: `probe-${index}@example.test`, role: 'viewer' })
          .expect(404);
      }

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
        .set(authHeader(user.accessToken))
        .send({ email: 'probe-last@example.test', role: 'viewer' })
        .expect(429);

      expect(response.body.code).toBe('TOO_MANY_REQUESTS');
      expect(response.body.details.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('is 400 for an address that is not an email, and for an unknown role', async () => {
      const user = await owner();

      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
        .set(authHeader(user.accessToken))
        .send({ email: 'not-an-address', role: 'viewer' })
        .expect(400);

      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
        .set(authHeader(user.accessToken))
        .send({ email: 'colleague@example.test', role: 'owner' })
        .expect(400);
    });

    it('is 404 for a non-owner, before the address is ever looked up', async () => {
      const user = await createMockTestUser(context);

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: 'somebody-else' }) as never,
      );

      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
        .set(authHeader(user.accessToken))
        .send({ email: 'colleague@example.test', role: 'viewer' })
        .expect(404);

      // THE ORDER MATTERS: a stranger must not be able to use somebody else's
      // transcript id as a free account-existence probe.
      expect(prismaMock.user.findFirst).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // PATCH and DELETE
  // ==========================================================================

  describe('PATCH /api/transcripts/:id/shares/:userId', () => {
    it('changes the role and answers 200', async () => {
      const user = await owner();

      prismaMock.transcriptShare.findUnique.mockResolvedValue({ role: 'viewer' } as never);
      prismaMock.transcriptShare.update.mockResolvedValue(shareRow({ role: 'editor' }) as never);

      const response = await request(context.app.getHttpServer())
        .patch(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares/${RECIPIENT_ID}`)
        .set(authHeader(user.accessToken))
        .send({ role: 'editor' })
        .expect(200);

      expect(response.body.data.role).toBe('editor');
    });

    it('is 404 for a user who holds no share', async () => {
      const user = await owner();

      prismaMock.transcriptShare.findUnique.mockResolvedValue(null as never);

      await request(context.app.getHttpServer())
        .patch(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares/${RECIPIENT_ID}`)
        .set(authHeader(user.accessToken))
        .send({ role: 'editor' })
        .expect(404);
    });
  });

  describe('DELETE /api/transcripts/:id/shares/:userId', () => {
    it('revokes and answers 204 with no body', async () => {
      const user = await owner();

      prismaMock.transcriptShare.deleteMany.mockResolvedValue({ count: 1 } as never);

      const response = await request(context.app.getHttpServer())
        .delete(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares/${RECIPIENT_ID}`)
        .set(authHeader(user.accessToken))
        .expect(204);

      expect(response.body).toEqual({});
    });

    it('lets a RECIPIENT leave — gated on transcripts:read, not transcripts:write', async () => {
      const user = await createMockTestUser(context, { roleName: 'viewer' });

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: 'somebody-else' }) as never,
      );
      prismaMock.transcriptShare.findUnique.mockResolvedValue({ role: 'viewer' } as never);
      prismaMock.transcriptShare.deleteMany.mockResolvedValue({ count: 1 } as never);

      await request(context.app.getHttpServer())
        .delete(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares/${user.id}`)
        .set(authHeader(user.accessToken))
        .expect(204);
    });

    it('refuses an EDITOR trying to revoke somebody else — 404, not 403', async () => {
      const user = await createMockTestUser(context);

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: 'somebody-else' }) as never,
      );
      prismaMock.transcriptShare.findUnique.mockResolvedValue({ role: 'editor' } as never);

      const response = await request(context.app.getHttpServer())
        .delete(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares/${RECIPIENT_ID}`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(response.body.message).toBe(TRANSCRIPT_NOT_FOUND_MESSAGE);
      expect(prismaMock.transcriptShare.deleteMany).not.toHaveBeenCalled();
    });
  });
});

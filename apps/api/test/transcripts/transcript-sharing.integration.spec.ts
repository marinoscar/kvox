import {
  BadRequestException,
  HttpException,
  HttpStatus,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GrantsService } from '@marinoscar/platform-api/sharing';
import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { CredentialsService } from '@marinoscar/platform-api/credentials';
import { STORAGE_PROVIDER } from '@marinoscar/platform-api/storage';
import {
  SHARE_NOT_FOUND_MESSAGE,
  SHARE_RECIPIENT_NOT_FOUND_MESSAGE,
  SHARE_WITH_SELF_MESSAGE,
  TRANSCRIPT_NOT_FOUND_MESSAGE,
} from '@marinoscar/kvox-api/transcripts';

// =============================================================================
// The deprecated `:id/shares` routes over the wire (issue #29, epic #19; adapters since #485)
// =============================================================================
//
// A share is a platform `grants` row since #485, and these four routes are thin
// adapters over `GrantsService` kept for one release. HTTP-level coverage of what a
// client of the OLD routes meets, which must not have changed:
//
//   * a NON-OWNER reading, granting or changing a share gets **404**, and the SAME
//     message a caller gets for a transcript that does not exist ('Transcript not
//     found', never the platform's 'Resource not found');
//   * an unknown, deactivated or foreign address gets the one generic **404** that
//     names no address (the platform's 422 `NOT_AN_ORG_MEMBER` never reaches the client);
//   * sharing with yourself is the old **400** message;
//   * a run of misses is **429** (the platform's lookup throttle);
//   * an honest grant is **201**, a revoke is **204**, and the response keeps the old
//     share shape, with `:userId` still the RECIPIENT's id;
//   * `DELETE` is reachable with `transcripts:read` alone, because "leave" must not
//     need a write permission on somebody else's recording.
//
// `GrantsService` is a fake here; the real service, `AccessPolicy` and the grants
// table run in `transcript-sharing.db.spec.ts`, which also carries the RBAC MATRIX
// (owner, editor, viewer, stranger, revoked). The access decision below does run
// for real over the mocked database: the owner and the grants it reads are rows
// the mock returns, and `loadOwners` is the registered one.
// =============================================================================

const TRANSCRIPTS = '/api/transcripts';
const TRANSCRIPT_ID = '11111111-2222-4333-8444-555555555555';
const RECIPIENT_ID = '22222222-3333-4444-8555-666666666666';
const GRANT_ID = '33333333-4444-4555-8666-777777777777';
const ORG_ID = '44444444-5555-4666-8777-888888888888';

const transcriptRow = (overrides: Record<string, unknown> = {}) => ({
  id: TRANSCRIPT_ID,
  ownerId: 'owner-user-id',
  orgId: ORG_ID,
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
  recordedAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:10:00.000Z'),
  ...overrides,
});

/** A `GrantDto` as the platform returns it for a user grant. */
const grantDto = (overrides: Record<string, unknown> = {}) => ({
  id: GRANT_ID,
  orgId: ORG_ID,
  resourceType: 'transcript',
  resourceId: TRANSCRIPT_ID,
  grantee: {
    kind: 'user',
    userId: RECIPIENT_ID,
    email: 'colleague@example.test',
    displayName: 'A Colleague',
    groupId: null,
    groupName: null,
    ref: null,
    display: null,
  },
  role: 'viewer',
  expiresAt: null,
  revokedAt: null,
  grantedById: 'owner-user-id',
  createdAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

const page = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 100, totalPages: 1 });

/** The platform's refusal for an address that is not a member of the organization. */
const notAnOrgMember = () =>
  new UnprocessableEntityException({
    message: 'That person is not a member of this organization',
    details: { reason: 'NOT_AN_ORG_MEMBER' },
  });

describe('Transcript sharing integration (deprecated adapters)', () => {
  let context: TestContext;
  const grants = {
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    revoke: jest.fn(),
    sharedWithMe: jest.fn(),
    deleteForResources: jest.fn(),
  };

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        { provide: GrantsService, useValue: grants },
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
    // No grant names the caller, unless a test says so.
    prismaMock.grant.findMany.mockResolvedValue([] as never);
    grants.list.mockResolvedValue(page([]));
  });

  /** The transcript the access check reads: the row, and `loadOwners`' view of it. */
  function transcriptOwnedBy(ownerId: string) {
    prismaMock.transcript.findUnique.mockResolvedValue(transcriptRow({ ownerId }) as never);
    prismaMock.transcript.findMany.mockResolvedValue([{ id: TRANSCRIPT_ID, orgId: ORG_ID, ownerId }] as never);
  }

  /** An owner whose token authenticates and whose transcript exists. */
  async function owner() {
    const user = await createMockTestUser(context);

    transcriptOwnedBy(user.id);

    return user;
  }

  /** A caller who does NOT own the transcript, holding `role` through a grant (or none). */
  async function nonOwner(
    role: 'viewer' | 'editor' | null,
    roleName: 'viewer' | 'contributor' | 'admin' = 'contributor',
  ) {
    const user = await createMockTestUser(context, { roleName });

    transcriptOwnedBy('somebody-else');
    prismaMock.grant.findMany.mockResolvedValue(
      (role
        ? [
            {
              resourceType: 'transcript',
              resourceId: TRANSCRIPT_ID,
              granteeKind: 'user',
              granteeUserId: user.id,
              granteeGroupId: null,
              granteeRef: null,
              role,
            },
          ]
        : []) as never,
    );

    return user;
  }

  // ==========================================================================
  // GET /:id/shares
  // ==========================================================================

  describe('GET /api/transcripts/:id/shares', () => {
    it('lists everyone the owner shared with, in the unchanged share shape', async () => {
      const user = await owner();

      grants.list.mockResolvedValue(page([grantDto()]));

      const response = await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.items).toEqual([
        {
          id: GRANT_ID,
          userId: RECIPIENT_ID,
          email: 'colleague@example.test',
          displayName: 'A Colleague',
          role: 'viewer',
          grantedById: 'owner-user-id',
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ]);
      expect(grants.list).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user.id, activeOrgId: ORG_ID }),
        expect.objectContaining({ resourceType: 'transcript', resourceId: TRANSCRIPT_ID }),
      );
    });

    it('shows the OWNER as the grantor of a grant whose grantor account was deleted', async () => {
      const user = await owner();

      grants.list.mockResolvedValue(page([grantDto({ grantedById: null })]));

      const response = await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.items[0].grantedById).toBe(user.id);
    });

    it('is 404 — not 403 — for a NON-OWNER holding a share, with the same message a missing transcript gets', async () => {
      const user = await nonOwner('editor');

      const response = await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(response.body.message).toBe(TRANSCRIPT_NOT_FOUND_MESSAGE);
      expect(grants.list).not.toHaveBeenCalled();
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
    it('grants the share and answers 201, with the address normalised at the edge', async () => {
      const user = await owner();

      grants.create.mockResolvedValue(grantDto({ role: 'editor' }));

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
        .set(authHeader(user.accessToken))
        .send({ email: 'Colleague@Example.TEST', role: 'editor' })
        .expect(201);

      expect(response.body.data).toMatchObject({ userId: RECIPIENT_ID, role: 'editor', id: GRANT_ID });
      // NORMALISED AT THE EDGE: the DTO lowercases, so the lookup and the throttle
      // cannot disagree about what "the same address" means.
      expect(grants.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: user.id, activeOrgId: ORG_ID }),
        {
          resourceType: 'transcript',
          resourceId: TRANSCRIPT_ID,
          grantee: { kind: 'user', email: 'colleague@example.test' },
          role: 'editor',
        },
      );
    });

    it('is 404 with a message that names NO address when the platform refuses the grantee', async () => {
      const user = await owner();

      grants.create.mockRejectedValue(notAnOrgMember());

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
        .set(authHeader(user.accessToken))
        .send({ email: 'nobody@example.test', role: 'viewer' })
        .expect(404);

      // One generic answer for no account, a deactivated account and an account
      // outside the organization: the platform's 422 never reaches the client.
      expect(response.body.message).toBe(SHARE_RECIPIENT_NOT_FOUND_MESSAGE);
      expect(JSON.stringify(response.body)).not.toContain('nobody@example.test');
      expect(JSON.stringify(response.body)).not.toContain('NOT_AN_ORG_MEMBER');
    });

    it('answers sharing with YOURSELF with the old 400, not the generic 404', async () => {
      const user = await owner();

      grants.create.mockRejectedValue(
        new BadRequestException({
          message: 'You cannot share a record with yourself',
          details: { reason: 'SELF_GRANT' },
        }),
      );

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
        .set(authHeader(user.accessToken))
        .send({ email: user.email, role: 'viewer' })
        .expect(400);

      expect(response.body.message).toBe(SHARE_WITH_SELF_MESSAGE);
    });

    it('passes the platform lookup throttle through as 429', async () => {
      const user = await owner();

      grants.create.mockRejectedValue(
        new HttpException(
          { message: 'Too many lookups', details: { reason: 'LOOKUP_THROTTLED' } },
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );

      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
        .set(authHeader(user.accessToken))
        .send({ email: 'probe@example.test', role: 'viewer' })
        .expect(429);
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

      expect(grants.create).not.toHaveBeenCalled();
    });

    it('is 404 for a non-owner, before the platform is ever asked to look an address up', async () => {
      const user = await nonOwner('editor');

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares`)
        .set(authHeader(user.accessToken))
        .send({ email: 'colleague@example.test', role: 'viewer' })
        .expect(404);

      expect(response.body.message).toBe(TRANSCRIPT_NOT_FOUND_MESSAGE);
      // THE ORDER MATTERS: a stranger must not be able to use somebody else's
      // transcript id as a free account-existence probe.
      expect(grants.create).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // PATCH and DELETE
  // ==========================================================================

  describe('PATCH /api/transcripts/:id/shares/:userId', () => {
    it('changes the role of the RECIPIENT\'s grant and answers 200', async () => {
      const user = await owner();

      grants.list.mockResolvedValue(page([grantDto()]));
      grants.update.mockResolvedValue(grantDto({ role: 'editor' }));

      const response = await request(context.app.getHttpServer())
        .patch(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares/${RECIPIENT_ID}`)
        .set(authHeader(user.accessToken))
        .send({ role: 'editor' })
        .expect(200);

      expect(response.body.data.role).toBe('editor');
      expect(grants.update).toHaveBeenCalledWith(expect.anything(), GRANT_ID, { role: 'editor' });
    });

    it('is 404 for a user who holds no share', async () => {
      const user = await owner();

      const response = await request(context.app.getHttpServer())
        .patch(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares/${RECIPIENT_ID}`)
        .set(authHeader(user.accessToken))
        .send({ role: 'editor' })
        .expect(404);

      expect(response.body.message).toBe(SHARE_NOT_FOUND_MESSAGE);
      expect(grants.update).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/transcripts/:id/shares/:userId', () => {
    it('revokes the recipient\'s grant and answers 204 with no body', async () => {
      const user = await owner();

      grants.list.mockResolvedValue(page([grantDto()]));
      grants.revoke.mockResolvedValue(undefined);

      const response = await request(context.app.getHttpServer())
        .delete(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares/${RECIPIENT_ID}`)
        .set(authHeader(user.accessToken))
        .expect(204);

      expect(response.body).toEqual({});
      expect(grants.revoke).toHaveBeenCalledWith(expect.anything(), GRANT_ID);
    });

    it('lets a RECIPIENT leave — gated on transcripts:read, not transcripts:write', async () => {
      const user = await nonOwner('viewer', 'viewer');

      grants.sharedWithMe.mockResolvedValue({
        items: [{ grantId: GRANT_ID, resourceType: 'transcript', resourceId: TRANSCRIPT_ID, role: 'viewer', via: 'user_grant' }],
        total: 1,
        page: 1,
        pageSize: 100,
        totalPages: 1,
      });
      grants.revoke.mockResolvedValue(undefined);

      await request(context.app.getHttpServer())
        .delete(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares/${user.id}`)
        .set(authHeader(user.accessToken))
        .expect(204);

      expect(grants.revoke).toHaveBeenCalledWith(expect.anything(), GRANT_ID);
      // Leaving never lists the share list: that is the owner's address book.
      expect(grants.list).not.toHaveBeenCalled();
    });

    it('refuses an EDITOR trying to revoke somebody else — 404, not 403', async () => {
      const user = await nonOwner('editor');

      const response = await request(context.app.getHttpServer())
        .delete(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/shares/${RECIPIENT_ID}`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(response.body.message).toBe(TRANSCRIPT_NOT_FOUND_MESSAGE);
      expect(grants.revoke).not.toHaveBeenCalled();
    });
  });
});

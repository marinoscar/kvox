import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { CredentialsService } from '../../src/credentials/credentials.service';
import { STORAGE_PROVIDER } from '../../src/storage/providers/storage-provider.interface';

// =============================================================================
// Corrections over HTTP (issue #27, epic #19)
// =============================================================================
//
// The acceptance criteria that are about the WIRE rather than about a reducer:
//
//   * a **viewer** — someone who can read the transcript but does not hold
//     `transcripts:write` — gets **403** on `POST /:id/operations`;
//   * a user with **no share at all** gets **404**, never 403, because the
//     existence of a transcript id is itself private (spec §6.1);
//   * a **viewer share** also gets 404 rather than 403, which is the same rule
//     one level down: the ROLE of a share is not something the holder of a
//     lesser one gets to enumerate;
//   * a stale `rev` answers **409** with `{ currentVersion, conflicts }`
//     naming every conflicting entity;
//   * a repeated `clientBatchId` answers with the ORIGINAL version and creates
//     no second one.
//
// Everything except `PrismaService`, `CredentialsService` and the storage
// provider is what `AppModule` wires — the same boundary a production request
// crosses, the global `ZodValidationPipe` included.
// =============================================================================

const TRANSCRIPTS = '/api/transcripts';
const TRANSCRIPT_ID = '11111111-2222-4333-8444-555555555555';
const SEGMENT_ID = '22222222-3333-4444-8555-666666666666';
const SECOND_SEGMENT_ID = '33333333-4444-4555-8666-777777777777';
const SPEAKER_A = '44444444-5555-4666-8777-888888888888';
const SPEAKER_B = '55555555-6666-4777-8888-999999999999';

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
  wordCount: 6,
  currentVersion: 3,
  failureReason: null,
  provider: 'assemblyai',
  providerJobId: 'remote-1',
  providerOptions: {},
  sourceObjectId: 'obj-source',
  playbackObjectId: null,
  rawResultObjectId: null,
  remoteDeletedAt: null,
  submittedAt: new Date('2026-01-01T00:00:00.000Z'),
  completedAt: new Date('2026-01-01T00:10:00.000Z'),
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:10:00.000Z'),
  ...overrides,
});

const speakerRows = [
  { id: SPEAKER_A, label: 'A', displayName: 'Speaker A', colorIndex: 0, rev: 1 },
  { id: SPEAKER_B, label: 'B', displayName: 'Speaker B', colorIndex: 1, rev: 1 },
];

const segmentRows = [
  {
    id: SEGMENT_ID,
    speakerId: SPEAKER_A,
    startMs: 0,
    endMs: 1000,
    ordinal: 1000,
    text: 'hello there world',
    words: [],
    wordsAlignment: 'exact',
    confidence: null,
    origin: 'ai',
    rev: 1,
    editedAt: null,
  },
  {
    id: SECOND_SEGMENT_ID,
    speakerId: SPEAKER_B,
    startMs: 1000,
    endMs: 2000,
    ordinal: 2000,
    text: 'and a second line',
    words: [],
    wordsAlignment: 'exact',
    confidence: null,
    origin: 'ai',
    rev: 1,
    editedAt: null,
  },
];

describe('Transcript corrections Integration', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        {
          provide: CredentialsService,
          useValue: { describe: jest.fn(), getSecret: jest.fn() },
        },
        {
          provide: STORAGE_PROVIDER,
          useValue: {
            getBucket: jest.fn().mockReturnValue('test-bucket'),
            upload: jest.fn(),
            download: jest.fn(),
            delete: jest.fn(),
            getSignedDownloadUrl: jest.fn(),
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

    prismaMock.transcriptSpeaker.findMany.mockResolvedValue(speakerRows as never);
    prismaMock.transcriptSegment.findMany.mockResolvedValue(segmentRows as never);
    prismaMock.transcriptSegment.update.mockResolvedValue({} as never);
    prismaMock.transcriptSegment.createMany.mockResolvedValue({ count: 0 } as never);
    prismaMock.transcriptSegment.deleteMany.mockResolvedValue({ count: 0 } as never);
    prismaMock.transcriptSpeaker.createMany.mockResolvedValue({ count: 0 } as never);
    prismaMock.transcriptSpeaker.deleteMany.mockResolvedValue({ count: 0 } as never);
    prismaMock.transcript.updateMany.mockResolvedValue({ count: 1 } as never);
    prismaMock.transcript.update.mockResolvedValue({} as never);
    prismaMock.transcriptVersion.findUnique.mockResolvedValue(null as never);
    prismaMock.transcriptVersion.findFirst.mockResolvedValue({ version: 3 } as never);
    prismaMock.transcriptVersion.findMany.mockResolvedValue([] as never);
    prismaMock.transcriptVersion.create.mockResolvedValue({} as never);
    prismaMock.$queryRaw.mockResolvedValue([{ bytes: 0 }] as never);
  });

  /** A signed-in user who OWNS the transcript. */
  async function owner() {
    const user = await createMockTestUser(context, { roleName: 'contributor' });

    prismaMock.transcript.findUnique.mockResolvedValue(
      transcriptRow({ ownerId: user.id }) as never,
    );

    return user;
  }

  const batch = (ops: unknown[], overrides: Record<string, unknown> = {}) => ({
    baseVersion: 3,
    clientBatchId: 'batch-00000001',
    ops,
    ...overrides,
  });

  // ==========================================================================
  // Access
  // ==========================================================================

  describe('access', () => {
    it('gives a caller with no share a 404, never a 403', async () => {
      const stranger = await createMockTestUser(context, { email: 'stranger@example.com' });

      prismaMock.transcript.findUnique.mockResolvedValue(transcriptRow() as never);
      prismaMock.transcriptShare.findUnique.mockResolvedValue(null as never);

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/operations`)
        .set(authHeader(stranger.accessToken))
        .send(batch([{ op: 'segment.update_text', segmentId: SEGMENT_ID, rev: 1, text: 'x' }]))
        .expect(404);

      expect(response.body.message).toBe('Transcript not found');
    });

    it('gives a VIEWER SHARE a 404 too — a share role is not enumerable', async () => {
      const sharee = await createMockTestUser(context, { email: 'sharee@example.com' });

      prismaMock.transcript.findUnique.mockResolvedValue(transcriptRow() as never);
      prismaMock.transcriptShare.findUnique.mockResolvedValue({ role: 'viewer' } as never);

      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/operations`)
        .set(authHeader(sharee.accessToken))
        .send(batch([{ op: 'segment.update_text', segmentId: SEGMENT_ID, rev: 1, text: 'x' }]))
        .expect(404);
    });

    it('gives a viewer who lacks `transcripts:write` a 403', async () => {
      // A caller who can already READ the transcript is told the truth about
      // the permission — there is nothing left to conceal from somebody who
      // can see the thing (see `TranscriptAccessService`'s header).
      const user = await createMockTestUser(context, { roleName: 'viewer' });

      stripTranscriptsWrite(user.id);

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: user.id }) as never,
      );

      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/operations`)
        .set(authHeader(user.accessToken))
        .send(batch([{ op: 'segment.update_text', segmentId: SEGMENT_ID, rev: 1, text: 'x' }]))
        .expect(403);
    });

    it('is 401 without a token', async () => {
      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/operations`)
        .send(batch([]))
        .expect(401);
    });

    it('lets a viewer who CAN read search, which is a view-level route', async () => {
      const user = await createMockTestUser(context, { roleName: 'viewer' });

      prismaMock.transcript.findUnique.mockResolvedValue(
        transcriptRow({ ownerId: user.id }) as never,
      );

      const response = await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/search?q=hello`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.total).toBe(1);
    });
  });

  // ==========================================================================
  // Validation — proof the global ZodValidationPipe is actually mounted
  // ==========================================================================

  describe('validation', () => {
    it.each([
      ['an empty op list', { baseVersion: 3, clientBatchId: 'batch-00000001', ops: [] }],
      ['a missing clientBatchId', { baseVersion: 3, ops: [] }],
      [
        'an unknown op',
        { baseVersion: 3, clientBatchId: 'batch-00000001', ops: [{ op: 'segment.nope' }] },
      ],
      [
        'a split with BOTH a word index and a char offset',
        {
          baseVersion: 3,
          clientBatchId: 'batch-00000001',
          ops: [
            { op: 'segment.split', segmentId: SEGMENT_ID, rev: 1, atWordIndex: 1, atCharOffset: 4 },
          ],
        },
      ],
      [
        'a split with NEITHER',
        {
          baseVersion: 3,
          clientBatchId: 'batch-00000001',
          ops: [{ op: 'segment.split', segmentId: SEGMENT_ID, rev: 1 }],
        },
      ],
      [
        'more than 200 ops',
        {
          baseVersion: 3,
          clientBatchId: 'batch-00000001',
          ops: Array.from({ length: 201 }, () => ({
            op: 'segment.update_text',
            segmentId: SEGMENT_ID,
            rev: 1,
            text: 'x',
          })),
        },
      ],
    ])('rejects %s with a 400', async (_name, body) => {
      const user = await owner();

      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/operations`)
        .set(authHeader(user.accessToken))
        .send(body)
        .expect(400);
    });

    it('rejects a search with no query', async () => {
      const user = await owner();

      await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/search`)
        .set(authHeader(user.accessToken))
        .expect(400);
    });

    it('rejects `matchCase=yes` rather than guessing', async () => {
      // `z.coerce.boolean()` would read "yes" as true; the explicit enum
      // refuses anything that is not one of the two spellings a query carries.
      const user = await owner();

      await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/search?q=x&matchCase=yes`)
        .set(authHeader(user.accessToken))
        .expect(400);
    });
  });

  // ==========================================================================
  // The happy path, the conflict and the retry
  // ==========================================================================

  describe('POST /:id/operations', () => {
    it('applies a correction and answers with the new version', async () => {
      const user = await owner();

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/operations`)
        .set(authHeader(user.accessToken))
        .send(
          batch([
            { op: 'segment.update_text', segmentId: SEGMENT_ID, rev: 1, text: 'hello there World' },
          ]),
        )
        .expect(201);

      expect(response.body.data.version).toBe(4);
      expect(response.body.data.idempotentReplay).toBe(false);
      expect(response.body.data.segments).toHaveLength(2);
      expect(response.body.data.segments[0]).toMatchObject({
        id: SEGMENT_ID,
        text: 'hello there World',
        rev: 2,
      });
      // The version row carries the concrete op, not a summary of intent.
      expect(prismaMock.transcriptVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ version: 4, kind: 'edit', clientBatchId: 'batch-00000001' }),
        }),
      );
      // `current_version` is bumped conditionally — the write IS the check.
      expect(prismaMock.transcript.updateMany).toHaveBeenCalledWith({
        where: { id: TRANSCRIPT_ID, currentVersion: 3 },
        data: { currentVersion: 4 },
      });
    });

    it('answers 409 with every conflicting entity named at once', async () => {
      const user = await owner();

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/operations`)
        .set(authHeader(user.accessToken))
        .send(
          batch([
            { op: 'segment.update_text', segmentId: SEGMENT_ID, rev: 99, text: 'nope' },
            { op: 'speaker.rename', speakerId: SPEAKER_B, rev: 99, displayName: 'nope' },
          ]),
        )
        .expect(409);

      // Under `details`, because the global `HttpExceptionFilter` owns the
      // error envelope and reads nothing else off a thrown payload.
      expect(response.body).toMatchObject({ statusCode: 409, code: 'CONFLICT' });
      expect(response.body.details).toEqual({
        currentVersion: 3,
        conflicts: [
          { entity: 'segment', id: SEGMENT_ID, current: 1 },
          { entity: 'speaker', id: SPEAKER_B, current: 1 },
        ],
      });
      // Nothing was written: the whole batch is one transaction.
      expect(prismaMock.transcriptVersion.create).not.toHaveBeenCalled();
    });

    it('returns the ORIGINAL result for a repeated clientBatchId', async () => {
      const user = await owner();

      prismaMock.transcriptVersion.findUnique.mockResolvedValue({
        version: 3,
        summary: 'Corrected 1 line',
      } as never);

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/operations`)
        .set(authHeader(user.accessToken))
        .send(
          batch([
            { op: 'segment.update_text', segmentId: SEGMENT_ID, rev: 1, text: 'anything' },
          ]),
        )
        .expect(201);

      expect(response.body.data).toMatchObject({
        version: 3,
        summary: 'Corrected 1 line',
        idempotentReplay: true,
      });
      expect(prismaMock.transcriptVersion.create).not.toHaveBeenCalled();
      expect(prismaMock.transcript.updateMany).not.toHaveBeenCalled();
    });

    it('returns a merge undo payload naming the source speakers previous segments', async () => {
      const user = await owner();

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/operations`)
        .set(authHeader(user.accessToken))
        .send(batch([{ op: 'speaker.merge', sourceIds: [SPEAKER_B], targetId: SPEAKER_A }]))
        .expect(201);

      expect(response.body.data.merges).toEqual([
        {
          targetId: SPEAKER_A,
          sources: [
            {
              speakerId: SPEAKER_B,
              label: 'B',
              displayName: 'Speaker B',
              colorIndex: 1,
              segmentIds: [SECOND_SEGMENT_ID],
            },
          ],
        },
      ]);
    });

    it('is 400 for an op that can never apply, whatever the caller re-fetches', async () => {
      const user = await owner();

      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/operations`)
        .set(authHeader(user.accessToken))
        // `hello there world` is three words; there is no word 9 to split at.
        .send(
          batch([
            { op: 'segment.split', segmentId: SEGMENT_ID, rev: 1, atWordIndex: 9 },
          ]),
        )
        .expect(400);
    });
  });

  // ==========================================================================
  // Search, versions and restore
  // ==========================================================================

  describe('GET /:id/search', () => {
    it('reports offsets, the segment start and an exact total', async () => {
      const user = await owner();

      const response = await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/search?q=there&wholeWord=true`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toMatchObject({
        q: 'there',
        wholeWord: true,
        matchCase: false,
        total: 1,
        segmentCount: 1,
        truncated: false,
      });
      expect(response.body.data.matches[0]).toMatchObject({
        segmentId: SEGMENT_ID,
        speakerId: SPEAKER_A,
        startMs: 0,
        start: 6,
        end: 11,
      });
    });
  });

  describe('GET /:id/versions', () => {
    it('lists the history newest first', async () => {
      const user = await owner();

      prismaMock.transcriptVersion.findMany.mockResolvedValue([
        {
          version: 1,
          kind: 'ai_original',
          summary: 'Transcribed by AssemblyAI',
          restoredFromVersion: null,
          snapshotObjectId: 'object-1',
          ops: [],
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          author: null,
        },
      ] as never);

      const response = await request(context.app.getHttpServer())
        .get(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/versions`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.currentVersion).toBe(3);
      expect(response.body.data.items[0]).toMatchObject({
        version: 1,
        kind: 'ai_original',
        // null MEANS the AI — spec §4.5's own convention.
        author: null,
        hasSnapshot: true,
      });
      expect(response.body.data.nextCursor).toBeNull();
    });
  });

  describe('POST /:id/versions/:v/restore', () => {
    it('refuses a stale baseVersion with a 409 rather than discarding unseen edits', async () => {
      const user = await owner();

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/versions/1/restore`)
        .set(authHeader(user.accessToken))
        .send({ baseVersion: 2 })
        .expect(409);

      expect(response.body.details.currentVersion).toBe(3);
    });

    it('refuses to restore the version that is already current', async () => {
      const user = await owner();

      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/versions/3/restore`)
        .set(authHeader(user.accessToken))
        .send({ baseVersion: 3 })
        .expect(409);
    });

    it('rejects a non-numeric version in the path', async () => {
      const user = await owner();

      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/versions/abc/restore`)
        .set(authHeader(user.accessToken))
        .send({ baseVersion: 3 })
        .expect(400);
    });
  });
});

/**
 * Take `transcripts:write` away from one mocked user.
 *
 * No seeded role lacks it — `transcripts:write` is deliberately granted to all
 * three, including Viewer, because creating a transcript is the action the
 * whole epic exists to enable (spec §6.2). So the 403 path has to be arranged
 * explicitly rather than by picking a weaker role, and this wraps the mock
 * lookup the JWT strategy uses rather than reaching into the fixture registry.
 */
function stripTranscriptsWrite(userId: string): void {
  const original = prismaMock.user.findUnique.getMockImplementation();

  prismaMock.user.findUnique.mockImplementation(async (args: never) => {
    const user = (await original?.(args)) as
      | { id: string; userRoles?: Array<{ role: { rolePermissions: Array<{ permission: { name: string } }> } }> }
      | null;

    if (!user || user.id !== userId || !user.userRoles) return user as never;

    return {
      ...user,
      userRoles: user.userRoles.map((userRole) => ({
        ...userRole,
        role: {
          ...userRole.role,
          rolePermissions: userRole.role.rolePermissions.filter(
            (rolePermission) => rolePermission.permission.name !== 'transcripts:write',
          ),
        },
      })),
    } as never;
  });
}

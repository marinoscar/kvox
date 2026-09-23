import request from 'supertest';

import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { TRANSCRIPT_NAME_CHECK_JOB_TYPE } from '../../src/transcripts/job-types';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { CredentialsService } from '../../src/credentials/credentials.service';
import { STORAGE_PROVIDER } from '../../src/storage/providers/storage-provider.interface';

// =============================================================================
// AI name correction over HTTP — `POST /api/transcripts/:id/name-checks`
// (issues #328 and #330, epic #326)
// =============================================================================
//
// Follows `transcript-corrections.integration.spec.ts`'s pattern: everything
// AppModule wires, only Prisma/credentials/storage stood in for. Two
// contracts:
//
//   * a well-formed request from the OWNER is a 202 that queues
//     `transcript.name_check`, carrying the created run's id as
//     `payload.checkId`;
//   * a caller with NO SHARE AT ALL gets 404, never 403 — the same rule every
//     other transcript route follows (spec §6.1).
// =============================================================================

const TRANSCRIPTS = '/api/transcripts';
const TRANSCRIPT_ID = '11111111-2222-4333-8444-555555555555';
const SPEAKER_A = '44444444-5555-4666-8777-888888888888';

/** `ai` policy with the feature actually switched on, mirroring notes.integration.spec.ts. */
const ENABLED_AI_SETTINGS = {
  ...DEFAULT_SYSTEM_SETTINGS,
  ai: {
    ...DEFAULT_SYSTEM_SETTINGS.ai,
    enabled: true,
    provider: 'openai',
    providers: {
      openai: {
        ...DEFAULT_SYSTEM_SETTINGS.ai.providers.openai,
        allowedModels: ['gpt-4o'],
        defaultModel: 'gpt-4o',
      },
    },
  },
};

const transcriptRow = (overrides: Record<string, unknown> = {}) => ({
  id: TRANSCRIPT_ID,
  ownerId: 'owner-user-id',
  title: 'A recording',
  status: 'ready',
  transcriptionStatus: 'completed',
  playbackStatus: 'ready',
  language: 'en',
  durationMs: 120_000,
  speakerCount: 1,
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

const speakerRows = [{ id: SPEAKER_A, label: 'A', displayName: 'Oscar', colorIndex: 0, rev: 1 }];

const segmentRows = [
  {
    id: 'seg-1',
    rev: 1,
    speakerId: SPEAKER_A,
    startMs: 0,
    text: 'They called him Skar yesterday.',
    words: null,
  },
];

describe('AI name correction Integration', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        { provide: CredentialsService, useValue: { describe: jest.fn(), getSecret: jest.fn() } },
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

    prismaMock.systemSettings.findUnique.mockResolvedValue({
      key: 'global',
      value: ENABLED_AI_SETTINGS,
      version: 1,
      updatedAt: new Date(),
      updatedByUser: null,
    });
    // A saved key, so create() gets past the ai_key_missing 409.
    prismaMock.userAiCredential.findUnique.mockResolvedValue({ id: 'cred-1' });

    prismaMock.transcriptSpeaker.findMany.mockResolvedValue(speakerRows as never);
    prismaMock.transcriptSegment.findMany.mockResolvedValue(segmentRows as never);
    prismaMock.transcriptNameCheck.findMany.mockResolvedValue([] as never);
    prismaMock.transcriptNameCheck.create.mockImplementation(
      (async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'check-1',
        transcriptId: data.transcriptId,
        mode: data.mode,
        status: data.status,
        basedOnVersion: data.basedOnVersion,
        terms: data.terms,
        providerId: data.providerId,
        model: data.model,
        candidateCount: 0,
        suggestionCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        errorClass: null,
        error: null,
        createdAt: new Date(),
        startedAt: null,
        completedAt: null,
        jobId: null,
      })) as never,
    );
    prismaMock.transcriptNameCheck.update.mockImplementation(
      (async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'check-1',
        transcriptId: TRANSCRIPT_ID,
        mode: 'standard',
        status: 'pending',
        basedOnVersion: 3,
        terms: ['Oscar'],
        providerId: 'openai',
        model: 'gpt-4o',
        candidateCount: 0,
        suggestionCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        errorClass: null,
        error: null,
        createdAt: new Date(),
        startedAt: null,
        completedAt: null,
        ...data,
      })) as never,
    );
    prismaMock.job.create.mockResolvedValue({ id: 'job-1' } as never);
  });

  /** A signed-in user who OWNS the transcript. */
  async function owner() {
    const user = await createMockTestUser(context, { roleName: 'contributor' });
    prismaMock.transcript.findUnique.mockResolvedValue(transcriptRow({ ownerId: user.id }) as never);
    return user;
  }

  describe('POST /api/transcripts/:id/name-checks', () => {
    it('202s and queues transcript.name_check carrying the created run id', async () => {
      const user = await owner();

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/name-checks`)
        .set(authHeader(user.accessToken))
        .send({ mode: 'standard' })
        .expect(202);

      expect(response.body.data.run.id).toBe('check-1');
      expect(response.body.data.run.status).toBe('pending');
      expect(response.body.data.estimate).toBeDefined();

      const job = prismaMock.job.create.mock.calls[0][0].data;
      expect(job.type).toBe(TRANSCRIPT_NAME_CHECK_JOB_TYPE);
      expect(job.subjectId).toBe(TRANSCRIPT_ID);
      expect(job.payload).toEqual({ checkId: 'check-1' });
    });

    it('gives a caller with no share a 404, never a 403', async () => {
      const stranger = await createMockTestUser(context, { email: 'stranger@example.com' });

      prismaMock.transcript.findUnique.mockResolvedValue(transcriptRow() as never);
      prismaMock.transcriptShare.findUnique.mockResolvedValue(null as never);

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/name-checks`)
        .set(authHeader(stranger.accessToken))
        .send({ mode: 'standard' })
        .expect(404);

      expect(response.body.message).toBe('Transcript not found');
      expect(prismaMock.job.create).not.toHaveBeenCalled();
    });

    it('gives a VIEWER SHARE a 404 too — a share role is not enumerable', async () => {
      const sharee = await createMockTestUser(context, { email: 'sharee@example.com' });

      prismaMock.transcript.findUnique.mockResolvedValue(transcriptRow() as never);
      prismaMock.transcriptShare.findUnique.mockResolvedValue({ role: 'viewer' } as never);

      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/name-checks`)
        .set(authHeader(sharee.accessToken))
        .send({ mode: 'standard' })
        .expect(404);
    });

    it('is 401 without a token', async () => {
      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/name-checks`)
        .send({ mode: 'standard' })
        .expect(401);
    });

    it('400s when there is nothing to check', async () => {
      const user = await owner();
      prismaMock.transcriptSpeaker.findMany.mockResolvedValue([] as never);

      await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/name-checks`)
        .set(authHeader(user.accessToken))
        .send({ mode: 'standard' })
        .expect(400);
    });

    it('409s with ai_key_missing when the caller has no saved key', async () => {
      const user = await owner();
      prismaMock.userAiCredential.findUnique.mockResolvedValue(null as never);

      const response = await request(context.app.getHttpServer())
        .post(`${TRANSCRIPTS}/${TRANSCRIPT_ID}/name-checks`)
        .set(authHeader(user.accessToken))
        .send({ mode: 'standard' })
        .expect(409);

      expect(response.body.details?.reason ?? response.body.error?.details?.reason).toBe('ai_key_missing');
    });
  });
});

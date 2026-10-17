import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { mockPrismaTransaction, prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks, TEST_DEFAULT_ORG_ID } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import {
  TranscriptImportService,
  TranscriptObjectsService,
  TranscriptPipelineService,
} from '@marinoscar/kvox-api/transcripts';

// =============================================================================
// POST /api/transcripts/imports over the wire (issue #571)
// =============================================================================
//
// The REAL `AppModule` (guards, multipart parsing, the envelope) with `PrismaService`
// mocked and the storage writer and the queue-facing pipeline spied. Pins the HTTP
// contract: 401, 403 without `transcripts:write`, 400 for a body that is not multipart
// or has no `file`, the typed `details.reason` of a refused file, 413 over the size
// limit, and 201 with the new transcript's detail. The write itself, against a real
// database, is `transcript-import.db.spec.ts`.
// =============================================================================

const IMPORTS = '/api/transcripts/imports';
const OBJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** A valid `kvox.transcript/v1` document: synthetic, one named speaker and one placeholder. */
function validDocument(): Record<string, any> {
  return {
    schema: 'kvox.transcript/v1',
    transcript: {
      id: 'tr_http_1',
      title: 'Import over HTTP',
      language: 'en',
      durationMs: 6_000,
      version: 1,
      author: null,
      createdAt: '2026-03-01T10:00:00.000Z',
      exportedAt: '2026-03-02T10:00:00.000Z',
      recordedAt: '2026-02-28T09:00:00.000Z',
      provider: { id: 'assemblyai', model: 'best' },
      speakers: [
        { id: 'spk_1', displayName: 'Dana Example', talkTimeMs: 3_000 },
        { id: 'spk_2', displayName: 'Speaker B', talkTimeMs: 3_000 },
      ],
      segments: [
        { id: 'seg_1', speakerId: 'spk_1', startMs: 0, endMs: 3_000, text: 'Hello from a fixture.' },
        { id: 'seg_2', speakerId: 'spk_2', startMs: 3_000, endMs: 6_000, text: 'Hello back.' },
      ],
    },
  };
}

const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8');

describe('POST /api/transcripts/imports (integration)', () => {
  let context: TestContext;
  let put: jest.SpyInstance;
  let remove: jest.SpyInstance;
  let snapshot: jest.SpyInstance;
  let searchIndex: jest.SpyInstance;
  let importFile: jest.SpyInstance;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    mockPrismaTransaction();

    for (const spy of [put, remove, snapshot, searchIndex, importFile]) spy?.mockRestore();

    const objects = context.app.get(TranscriptObjectsService);
    const pipeline = context.app.get(TranscriptPipelineService);

    put = jest.spyOn(objects, 'put').mockResolvedValue({ id: OBJECT_ID } as never);
    remove = jest.spyOn(objects, 'deleteIfPresent').mockResolvedValue(true as never);
    snapshot = jest.spyOn(pipeline, 'enqueueSnapshot').mockResolvedValue(true as never);
    searchIndex = jest.spyOn(pipeline, 'enqueueSearchIndex').mockResolvedValue(undefined as never);
    importFile = jest.spyOn(context.app.get(TranscriptImportService), 'importFile');

    prismaMock.organization.findFirst.mockResolvedValue({ id: TEST_DEFAULT_ORG_ID } as never);
  });

  const upload = (token: string | undefined, body: Buffer, filename = 'talk.json', field = 'file') => {
    const req = request(context.app.getHttpServer()).post(IMPORTS);

    return (token ? req.set(authHeader(token)) : req).attach(field, body, {
      filename,
      contentType: 'application/json',
    });
  };

  /** Arrange the rows the 201's `GET /:id` shape reads, once the import has "created" the transcript. */
  function arrangeCreatedTranscript(ownerId: string): void {
    prismaMock.transcript.create.mockImplementation((async (args: { data: Record<string, unknown> }) => ({
      ...args.data,
    })) as never);
    prismaMock.transcriptSpeaker.create.mockImplementation((async () => ({
      id: `speaker-${Math.random().toString(16).slice(2)}`,
    })) as never);
    prismaMock.transcriptSegment.createMany.mockResolvedValue({ count: 2 } as never);
    prismaMock.transcriptVersion.create.mockResolvedValue({} as never);
    prismaMock.transcript.update.mockResolvedValue({} as never);

    prismaMock.transcript.findUnique.mockImplementation((async (args: { where: { id: string } }) => ({
      id: args.where.id,
      ownerId,
      orgId: TEST_DEFAULT_ORG_ID,
      title: 'Import over HTTP',
      status: 'ready',
      transcriptionStatus: 'completed',
      playbackStatus: 'not_needed',
      language: 'en',
      durationMs: 6_000,
      speakerCount: 2,
      wordCount: 6,
      currentVersion: 1,
      failureReason: null,
      provider: 'import',
      providerJobId: null,
      providerOptions: {},
      sourceObjectId: OBJECT_ID,
      playbackObjectId: null,
      rawResultObjectId: null,
      remoteDeletedAt: null,
      submittedAt: null,
      completedAt: new Date('2026-03-01T10:00:00.000Z'),
      deletedAt: null,
      createdAt: new Date('2026-03-01T10:00:00.000Z'),
      recordedAt: new Date('2026-02-28T09:00:00.000Z'),
      updatedAt: new Date('2026-03-01T10:00:00.000Z'),
      speakerIdentities: {},
    })) as never);
    prismaMock.transcriptSpeaker.findMany.mockResolvedValue([
      { id: 'sp-1', label: 'A', displayName: 'Dana Example', colorIndex: 0, rev: 1 },
      { id: 'sp-2', label: 'B', displayName: 'Speaker B', colorIndex: 1, rev: 1 },
    ] as never);
    prismaMock.storageObject.findMany.mockResolvedValue([] as never);
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  it('is 401 without a session', async () => {
    await upload(undefined, json(validDocument())).expect(401);
    expect(importFile).not.toHaveBeenCalled();
  });

  it('is 403 without transcripts:write, before anything is stored', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const original = prismaMock.user.findUnique.getMockImplementation();

    prismaMock.user.findUnique.mockImplementation((async (args: never) => {
      const found = (await original?.(args)) as
        | { id: string; userRoles?: Array<{ role: { rolePermissions: Array<{ permission: { name: string } }> } }> }
        | null;

      if (!found || found.id !== user.id || !found.userRoles) return found as never;

      return {
        ...found,
        userRoles: found.userRoles.map((userRole) => ({
          ...userRole,
          role: {
            ...userRole.role,
            rolePermissions: userRole.role.rolePermissions.filter(
              (rp) => rp.permission.name !== 'transcripts:write',
            ),
          },
        })),
      } as never;
    }) as never);

    await upload(user.accessToken, json(validDocument())).expect(403);
    expect(importFile).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  it('imports the file and answers 201 with the new transcript', async () => {
    const user = await createMockTestUser(context);

    arrangeCreatedTranscript(user.id);

    const response = await upload(user.accessToken, json(validDocument())).expect(201);

    expect(response.body.data).toMatchObject({
      title: 'Import over HTTP',
      status: 'ready',
      transcriptionStatus: 'completed',
      playbackStatus: 'not_needed',
      provider: 'import',
      currentVersion: 1,
      language: 'en',
    });
    expect(response.body.data.speakers.map((s: { displayName: string }) => s.displayName)).toEqual([
      'Dana Example',
      'Speaker B',
    ]);

    // The file itself is the transcript's source object, stored before the transaction.
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        storageKey: expect.stringMatching(/^transcripts\/[0-9a-f-]{36}\/source\/[0-9a-f-]{36}\.json$/),
        name: 'talk.json',
        mimeType: 'application/json',
        ownerId: user.id,
      }),
    );
    expect(prismaMock.transcript.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerId: user.id,
        status: 'ready',
        transcriptionStatus: 'completed',
        playbackStatus: 'not_needed',
        sourceObjectId: OBJECT_ID,
        provider: 'import',
        currentVersion: 1,
        recordedAt: new Date('2026-02-28T09:00:00.000Z'),
      }),
    });

    // Only the named speaker has an identity; the placeholder does not.
    const update = prismaMock.transcript.update.mock.calls[0][0] as { data: { speakerIdentities: Record<string, string> } };

    expect(Object.values(update.data.speakerIdentities)).toEqual(['Dana Example']);

    const createdId = (prismaMock.transcript.create.mock.calls[0][0] as { data: { id: string } }).data.id;

    expect(snapshot).toHaveBeenCalledWith(createdId, 1);
    expect(searchIndex).toHaveBeenCalledWith(createdId);
    expect(remove).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Not a usable request
  // ---------------------------------------------------------------------------

  it('is 400 when the body is not multipart', async () => {
    const user = await createMockTestUser(context);

    await request(context.app.getHttpServer())
      .post(IMPORTS)
      .set(authHeader(user.accessToken))
      .send(validDocument())
      .expect(400);

    expect(put).not.toHaveBeenCalled();
  });

  it('is 400 when the multipart body carries no file', async () => {
    const user = await createMockTestUser(context);

    await request(context.app.getHttpServer())
      .post(IMPORTS)
      .set(authHeader(user.accessToken))
      .field('note', 'no file here')
      .expect(400);

    expect(put).not.toHaveBeenCalled();
  });

  it('is 400 when the file is not in the "file" field', async () => {
    const user = await createMockTestUser(context);

    await upload(user.accessToken, json(validDocument()), 'talk.json', 'upload').expect(400);
    expect(put).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // A refused file: typed details.reason, nothing stored
  // ---------------------------------------------------------------------------

  async function expectRefused(body: Buffer, reason: string) {
    const user = await createMockTestUser(context);
    const response = await upload(user.accessToken, body).expect(400);

    expect(response.body.details).toMatchObject({ reason });
    expect(put).not.toHaveBeenCalled();
    expect(prismaMock.transcript.create).not.toHaveBeenCalled();

    return response;
  }

  it('is 400 not_json for a file that is not JSON', async () => {
    await expectRefused(Buffer.from('this is not json {', 'utf8'), 'not_json');
  });

  it('is 400 unsupported_schema for a foreign JSON-LD document', async () => {
    await expectRefused(
      json({ '@context': 'https://schema.example/', '@type': 'Thing', name: 'not a transcript' }),
      'unsupported_schema',
    );
  });

  it('is 400 unsupported_schema for a later version of the schema, naming it', async () => {
    const response = await expectRefused(
      json({ ...validDocument(), schema: 'kvox.transcript/v2' }),
      'unsupported_schema',
    );

    expect(response.body.details.schema).toBe('kvox.transcript/v2');
  });

  it('is 400 invalid_document for a document with an extra property, listing the issue', async () => {
    const doc = validDocument();

    doc.transcript.unexpected = true;

    const response = await expectRefused(json(doc), 'invalid_document');

    expect(Array.isArray(response.body.details.issues)).toBe(true);
    expect(response.body.details.issues.length).toBeGreaterThan(0);
  });

  it('is 400 unknown_speaker when a segment names an undeclared speaker', async () => {
    const doc = validDocument();

    doc.transcript.segments[0].speakerId = 'spk_missing';

    await expectRefused(json(doc), 'unknown_speaker');
  });

  it('is 400 empty_transcript when the document has no segments', async () => {
    const doc = validDocument();

    doc.transcript.segments = [];

    await expectRefused(json(doc), 'empty_transcript');
  });

  // ---------------------------------------------------------------------------
  // The size limit
  // ---------------------------------------------------------------------------

  it('is 413 over the 25 MiB import limit, before anything is stored', async () => {
    const user = await createMockTestUser(context);
    const tooBig = Buffer.alloc(25 * 1024 * 1024 + 1, 0x20);

    await upload(user.accessToken, tooBig).expect(413);
    expect(put).not.toHaveBeenCalled();
    expect(importFile).not.toHaveBeenCalled();
  });
});

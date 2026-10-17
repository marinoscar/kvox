// =============================================================================
// Real-Postgres test: the JSON export -> import round trip (issue #571)
// =============================================================================
//
// The acceptance criterion of the import: a transcript exported as `kvox.transcript/v1`
// and imported again is the same transcript. Nothing short of the real chain proves that:
//
//   seed rows -> the REAL `TranscriptExportService` + `JsonTranscriptExporter` (and the
//   export handler, writing to storage) -> the bytes read back out of storage ->
//   the REAL `TranscriptImportService` -> rows in a migrated database -> `materialize`
//   and a second export of the imported transcript.
//
// What it pins that the mocked tiers cannot: that the exporter's output satisfies the
// importer's parser; that the speaker names (including a name that exists only as an
// identity overlay) and the recording date survive; that segment order, timings, speaker
// mapping and confidence survive; that the imported transcript is `ready` with no audio
// and no transcription work; that `materialize(1)` equals the live tables; and that a
// second export yields the same document (ids differ).
//
// A `*.db.spec.ts` file, excluded from `npm test` and run by `npm run test:db`. See
// `../jobs/db-test-support.ts` for the probe.
// =============================================================================

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import type { PrismaService } from '../../src/prisma/prisma.service';
import type { StorageProvider } from '@marinoscar/platform-api/storage';
import type { RequestUser } from '@marinoscar/platform-api/identity';
import type { KvoxJobsPort } from '@marinoscar/kvox-api/ports';
import {
  JsonTranscriptExporter,
  ORDINAL_GAP,
  TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT,
  TranscriptExportHandler,
  TranscriptExportService,
  TranscriptExporterRegistry,
  TranscriptImportService,
  TranscriptMaterializeService,
  TranscriptObjectsService,
  TranscriptSnapshotHandler,
  resolveTranscriptsOptions,
  type TranscriptPipelineService,
} from '@marinoscar/kvox-api/transcripts';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { TmpDirStorageProvider } from '../helpers/tmp-storage-provider.helper';
import { createStorageObject, idsManagedBy } from '../helpers/storage-object.helper';
import { createDbAudit, createDbObjectStore } from '../helpers/db-managed-objects.helper';
import { createTranscript as createTranscriptRow } from '../helpers/transcript.helper';
import { createTranscriptAccess } from '../helpers/sharing-kit.helper';

const { describeWithDb } = resolveDbSuite('transcript-import.db.spec');

const TITLE_PREFIX = 'i571-import-';
const EMAIL_PREFIX = 'i571-import';
const KEY_PREFIX = 'i571-import/';

/** A recording date that is neither "now" nor the row's createdAt: the import must carry THIS one. */
const RECORDED_AT = new Date('2025-11-03T08:30:00.000Z');

/** What the document says about each segment, for comparing the two sides. */
interface SegmentView {
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
  wordsAlignment: string;
  words: Array<{ text: string; startMs: number; endMs: number; confidence: number | null }>;
}

describeWithDb('Transcript JSON import round trip (real Postgres)', () => {
  let prisma: PrismaClient;
  let baseDir: string;
  let storage: StorageProvider;

  let objects: TranscriptObjectsService;
  let materialize: TranscriptMaterializeService;
  let exportService: TranscriptExportService;
  let exportHandler: TranscriptExportHandler;
  let snapshotHandler: TranscriptSnapshotHandler;
  let importService: TranscriptImportService;
  let enqueueSnapshot: jest.Mock;
  let enqueueSearchIndex: jest.Mock;
  let emit: jest.Mock;

  let user: RequestUser;
  let ownerId: string;
  let sourceObjectId: string;

  beforeAll(async () => {
    prisma = createDbClient();
    await prisma.$connect();

    baseDir = await mkdtemp(join(tmpdir(), 'i571-import-'));
    storage = Object.assign(new TmpDirStorageProvider(baseDir), {
      getSignedDownloadUrl: async () => 'https://signed.example/export',
    }) as StorageProvider;

    const service = prisma as unknown as PrismaService;
    const store = createDbObjectStore(prisma, storage);

    objects = new TranscriptObjectsService(store, resolveTranscriptsOptions({}));
    materialize = new TranscriptMaterializeService(service, objects);

    const access = createTranscriptAccess(prisma);

    // A REAL `jobs` row per enqueue (the export links `job_id`, a foreign key), so the
    // "no transcription work" assertion below can look at the table.
    const enqueue = jest.fn(async (input: { type: string; subjectId?: string | null }) => {
      const row = await prisma.job.create({
        data: {
          type: input.type,
          reason: 'rerun',
          subjectType: 'transcript',
          subjectId: input.subjectId ?? null,
          status: 'pending',
        },
      });

      return { id: row.id, deduplicated: false };
    });
    const jobs = {
      enqueue,
      registerHandler: jest.fn(),
      isRegistered: jest.fn(),
      onSettled: jest.fn(),
      findActive: jest.fn().mockResolvedValue([]),
      tempPath: jest.fn(),
    } as unknown as KvoxJobsPort;

    const registry = new TranscriptExporterRegistry();

    new JsonTranscriptExporter(registry).onModuleInit();

    exportService = new TranscriptExportService(
      service,
      access,
      materialize,
      objects,
      registry,
      jobs,
      createDbAudit(prisma),
    );
    exportHandler = new TranscriptExportHandler(jobs, service, exportService, objects);
    snapshotHandler = new TranscriptSnapshotHandler(jobs, service, materialize, objects);

    enqueueSnapshot = jest.fn().mockResolvedValue(true);
    enqueueSearchIndex = jest.fn().mockResolvedValue(undefined);
    emit = jest.fn();

    // The graph's speaker-link listener is not part of this module graph (it lives in the
    // graph slice and enqueues `kg.speaker_link` on this event), so what this suite can
    // prove is the EVENT the import emits for it, with the right speakers.
    importService = new TranscriptImportService(
      service as never,
      { emit, subscribe: jest.fn() },
      createDbAudit(prisma),
      objects,
      { enqueueSnapshot, enqueueSearchIndex } as unknown as TranscriptPipelineService,
    );

    const account = await prisma.user.create({
      data: { email: `${EMAIL_PREFIX}-${randomUUID()}@example.test` },
    });

    ownerId = account.id;
    user = {
      id: account.id,
      email: account.email,
      roles: ['Contributor'],
      permissions: ['transcripts:read', 'transcripts:write'],
      isActive: true,
    };

    const source = await createStorageObject(prisma, {
      data: {
        name: 'recording.m4a',
        size: BigInt(1024),
        mimeType: 'audio/mp4',
        storageKey: `${KEY_PREFIX}${randomUUID()}`,
        managedBy: 'transcripts',
        uploadedById: account.id,
      },
    });

    sourceObjectId = source.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.storageObject.deleteMany({ where: { storageKey: { startsWith: KEY_PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
    await prisma.$disconnect();
    await rm(baseDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await cleanup();
    enqueueSnapshot.mockClear();
    enqueueSearchIndex.mockClear();
    emit.mockClear();
  });

  async function cleanup(): Promise<void> {
    const where = { transcript: { title: { startsWith: TITLE_PREFIX } } };

    await prisma.transcriptExport.deleteMany({ where });
    await prisma.job.deleteMany({ where: { type: 'transcript.export' } });
    await prisma.transcriptVersion.deleteMany({ where });
    await prisma.transcriptSegment.deleteMany({ where });
    await prisma.transcriptSpeaker.deleteMany({ where });
    await prisma.auditEvent.deleteMany({ where: { targetType: 'transcript' } });
    await prisma.transcript.deleteMany({ where: { title: { startsWith: TITLE_PREFIX } } });
    await prisma.storageObject.deleteMany({
      where: {
        id: {
          in: await idsManagedBy(prisma, 'transcripts', { storageKeyPrefix: 'transcripts/', uploadedByIds: [ownerId] }),
        },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Seeding: a transcript as the provider's ingest would have left it, then named
  // ---------------------------------------------------------------------------

  interface Seed {
    transcriptId: string;
    title: string;
    /** speaker id by label */
    speakers: Record<'A' | 'B' | 'C', string>;
  }

  async function seedTranscript(): Promise<Seed> {
    const title = `${TITLE_PREFIX}${randomUUID()}`;
    const transcript = await createTranscriptRow(prisma, {
      data: {
        ownerId,
        title,
        sourceObjectId,
        provider: 'assemblyai',
        providerOptions: { model: 'best' } as never,
        language: 'es',
        durationMs: 25_000,
        status: 'ready',
        transcriptionStatus: 'completed',
        currentVersion: 1,
        speakerCount: 3,
        wordCount: 12,
        recordedAt: RECORDED_AT,
      },
    });

    // A: still on its ingest placeholder, named only through the identity overlay (spec §4.6).
    // B: never named. C: renamed to a person's name on the row itself.
    const rows: Array<[string, string, number]> = [
      ['A', 'Speaker A', 0],
      ['B', 'Speaker B', 1],
      ['C', 'Lee Sample', 2],
    ];
    const speakers = {} as Seed['speakers'];

    for (const [label, displayName, colorIndex] of rows) {
      const speaker = await prisma.transcriptSpeaker.create({
        data: { transcriptId: transcript.id, label, displayName, colorIndex },
      });

      speakers[label as 'A' | 'B' | 'C'] = speaker.id;
    }

    await prisma.transcript.update({
      where: { id: transcript.id },
      data: { speakerIdentities: { [speakers.A]: 'Dana Example' } as never },
    });

    // Five segments: with words (exact), with interpolated words, with none, and with a
    // null confidence; spoken out of speaker order so the mapping is not just "A, B, C".
    const plan: Array<{
      speaker: 'A' | 'B' | 'C';
      startMs: number;
      endMs: number;
      text: string;
      confidence: number | null;
      alignment: 'exact' | 'interpolated' | 'none';
      words: Array<{ t: string; s: number; e: number; c: number | null }>;
    }> = [
      {
        speaker: 'A',
        startMs: 0,
        endMs: 4_000,
        text: 'Buenos días a todos.',
        confidence: 0.93,
        alignment: 'exact',
        words: [
          { t: 'Buenos', s: 0, e: 900, c: 0.95 },
          { t: 'días', s: 1_000, e: 1_800, c: 0.9 },
          { t: 'a', s: 1_900, e: 2_100, c: null },
          { t: 'todos.', s: 2_200, e: 4_000, c: 0.97 },
        ],
      },
      { speaker: 'B', startMs: 4_500, endMs: 8_000, text: 'Hola, empecemos.', confidence: 0.81, alignment: 'none', words: [] },
      {
        speaker: 'C',
        startMs: 8_500,
        endMs: 13_000,
        text: 'El primer punto es el presupuesto.',
        confidence: null,
        alignment: 'interpolated',
        words: [
          { t: 'El', s: 8_500, e: 8_900, c: null },
          { t: 'primer', s: 9_000, e: 9_700, c: null },
          { t: 'punto', s: 9_800, e: 10_500, c: null },
        ],
      },
      { speaker: 'A', startMs: 13_500, endMs: 18_000, text: 'De acuerdo, adelante.', confidence: 0.88, alignment: 'none', words: [] },
      { speaker: 'B', startMs: 18_500, endMs: 24_000, text: 'Gracias, continuamos.', confidence: 0.5, alignment: 'none', words: [] },
    ];

    for (const [index, segment] of plan.entries()) {
      await prisma.transcriptSegment.create({
        data: {
          id: randomUUID(),
          transcriptId: transcript.id,
          speakerId: speakers[segment.speaker],
          startMs: segment.startMs,
          endMs: segment.endMs,
          ordinal: (index + 1) * ORDINAL_GAP,
          text: segment.text,
          words: segment.words as never,
          wordsAlignment: segment.alignment,
          confidence: segment.confidence,
          origin: 'ai',
        },
      });
    }

    await prisma.transcriptVersion.create({
      data: {
        transcriptId: transcript.id,
        version: 1,
        kind: 'ai_original',
        authorId: null,
        summary: 'Transcribed by AssemblyAI',
        ops: [] as never,
      },
    });
    await snapshotHandler.process({
      id: 'seed-snapshot',
      payload: { transcriptId: transcript.id, version: 1 },
    } as never);

    return { transcriptId: transcript.id, title, speakers };
  }

  // ---------------------------------------------------------------------------
  // Export, read back, import
  // ---------------------------------------------------------------------------

  async function exportJson(transcriptId: string): Promise<Buffer> {
    const result = await exportService.requestExport(
      transcriptId,
      { format: 'json', options: { includeWords: true } } as never,
      user,
    );

    await exportHandler.process({
      id: randomUUID(),
      payload: { exportId: result.export.id, transcriptId },
    } as never);

    const row = await prisma.transcriptExport.findUniqueOrThrow({ where: { id: result.export.id } });

    expect(row.status).toBe('ready');
    expect(row.objectId).not.toBeNull();

    const stream = await objects.download(row.objectId as string);
    const chunks: Buffer[] = [];

    for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));

    return Buffer.concat(chunks);
  }

  /** The speaker names and segments of an export, with speaker ids resolved to names. */
  function view(bytes: Buffer): { recordedAt: string | undefined; speakers: string[]; segments: SegmentView[] } {
    const doc = JSON.parse(bytes.toString('utf8')).transcript;
    const nameOf = new Map<string, string>(doc.speakers.map((s: any) => [s.id, s.displayName]));

    return {
      recordedAt: doc.recordedAt,
      speakers: doc.speakers.map((s: any) => s.displayName),
      segments: doc.segments.map((s: any) => ({
        speaker: nameOf.get(s.speakerId) as string,
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text,
        confidence: s.confidence,
        wordsAlignment: s.wordsAlignment,
        words: s.words ?? [],
      })),
    };
  }

  // ===========================================================================
  // The round trip
  // ===========================================================================

  it('imports an exported transcript as the same transcript, ready, with no audio and no transcription work', async () => {
    const seed = await seedTranscript();
    const bytes = await exportJson(seed.transcriptId);

    // The export itself carries what the import will read: the date, the effective names.
    const exported = view(bytes);

    expect(exported.recordedAt).toBe(RECORDED_AT.toISOString());
    expect(exported.speakers).toEqual(expect.arrayContaining(['Dana Example', 'Speaker B', 'Lee Sample']));
    expect(exported.segments).toHaveLength(5);

    const jobsBefore = await prisma.job.count();

    const { transcriptId } = await importService.importFile(user, { filename: 'round-trip.json', body: bytes });

    expect(transcriptId).not.toBe(seed.transcriptId);

    // ---- the transcript row -------------------------------------------------
    const imported = await prisma.transcript.findUniqueOrThrow({ where: { id: transcriptId } });

    expect(imported).toMatchObject({
      ownerId,
      title: seed.title,
      language: 'es',
      status: 'ready',
      transcriptionStatus: 'completed',
      playbackStatus: 'not_needed',
      currentVersion: 1,
      provider: 'import',
      speakerCount: 3,
    });
    expect(imported.recordedAt?.toISOString()).toBe(RECORDED_AT.toISOString());
    expect(imported.deletedAt).toBeNull();

    // ---- speakers: names are the effective ones, identities exist for the named ----
    const speakers = await prisma.transcriptSpeaker.findMany({
      where: { transcriptId },
      orderBy: { colorIndex: 'asc' },
    });

    expect(speakers.map((s) => s.displayName)).toEqual(['Dana Example', 'Speaker B', 'Lee Sample']);

    const [dana, , lee] = speakers;

    expect(imported.speakerIdentities).toEqual({ [dana.id]: 'Dana Example', [lee.id]: 'Lee Sample' });

    // ---- segments: order, text, timings, speaker mapping, confidence ---------
    const segments = await prisma.transcriptSegment.findMany({
      where: { transcriptId },
      orderBy: { ordinal: 'asc' },
    });
    const nameById = new Map(speakers.map((s) => [s.id, s.displayName]));

    expect(
      segments.map((s) => ({
        speaker: nameById.get(s.speakerId),
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text,
        confidence: s.confidence,
        wordsAlignment: s.wordsAlignment,
      })),
    ).toEqual(
      exported.segments.map(({ words: _words, ...rest }) => rest),
    );
    expect(segments.map((s) => s.ordinal)).toEqual([...segments.map((s) => s.ordinal)].sort((a, b) => a - b));
    expect(segments.every((s) => s.origin === 'ai')).toBe(true);

    // Word timings survive in the column's terse shape, where the file had them.
    expect(segments[0].words).toEqual([
      { t: 'Buenos', s: 0, e: 900, c: 0.95 },
      { t: 'días', s: 1_000, e: 1_800, c: 0.9 },
      { t: 'a', s: 1_900, e: 2_100, c: null },
      { t: 'todos.', s: 2_200, e: 4_000, c: 0.97 },
    ]);
    expect(segments[1].words).toEqual([]);

    // ---- version 1, and materialize(1) == the live tables --------------------
    const versions = await prisma.transcriptVersion.findMany({ where: { transcriptId } });

    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, kind: 'ai_original', authorId: null });
    expect(versions[0].ops).toEqual([]);

    const materialized = await materialize.materialize(transcriptId, 1);

    expect(materialized.version).toBe(1);
    expect(
      materialized.state.speakers.map((s) => ({ id: s.id, displayName: s.displayName, colorIndex: s.colorIndex })),
    ).toEqual(speakers.map((s) => ({ id: s.id, displayName: s.displayName, colorIndex: s.colorIndex })));
    expect(
      materialized.state.segments.map((s) => ({
        id: s.id,
        speakerId: s.speakerId,
        startMs: s.startMs,
        endMs: s.endMs,
        ordinal: s.ordinal,
        text: s.text,
        words: s.words,
        wordsAlignment: s.wordsAlignment,
        confidence: s.confidence,
        origin: s.origin,
      })),
    ).toEqual(
      segments.map((s) => ({
        id: s.id,
        speakerId: s.speakerId,
        startMs: s.startMs,
        endMs: s.endMs,
        ordinal: s.ordinal,
        text: s.text,
        words: s.words,
        wordsAlignment: s.wordsAlignment,
        confidence: s.confidence,
        origin: s.origin,
      })),
    );

    // ---- the source object is the file, managed by transcripts ---------------
    const source = await prisma.storageObject.findUniqueOrThrow({ where: { id: imported.sourceObjectId } });

    expect(source).toMatchObject({ mimeType: 'application/json', name: 'round-trip.json' });
    expect(source.storageKey).toMatch(new RegExp(`^transcripts/${transcriptId}/source/`));

    // ---- no transcription or transcode work was created ----------------------
    const stray = await prisma.job.count({
      where: {
        subjectId: transcriptId,
        OR: [{ type: { startsWith: 'transcription.' } }, { type: 'media.audio.transcode' }],
      },
    });

    expect(stray).toBe(0);
    // The import wrote no job row of its own: its follow-ups go through the pipeline (below).
    expect(await prisma.job.count()).toBe(jobsBefore);

    // ---- what the import queued after the commit -----------------------------
    expect(enqueueSnapshot).toHaveBeenCalledWith(transcriptId, 1);
    expect(enqueueSearchIndex).toHaveBeenCalledWith(transcriptId);

    // The graph's speaker link listens for this event; only the NAMED speakers are in it.
    expect(emit).toHaveBeenCalledTimes(1);

    const [eventName, event] = emit.mock.calls[0];

    expect(eventName).toBe(TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT);
    expect(event).toMatchObject({ transcriptId, actorUserId: ownerId });
    expect([...event.speakerIds].sort()).toEqual([dana.id, lee.id].sort());
  });

  it('exports the imported transcript as the same document: same speakers, segments and recordedAt, new ids', async () => {
    const seed = await seedTranscript();
    const firstBytes = await exportJson(seed.transcriptId);
    const { transcriptId } = await importService.importFile(user, { filename: 'again.json', body: firstBytes });
    const secondBytes = await exportJson(transcriptId);

    const first = view(firstBytes);
    const second = view(secondBytes);

    expect(second.recordedAt).toBe(first.recordedAt);
    expect([...second.speakers].sort()).toEqual([...first.speakers].sort());
    // Segments and their word timings, in order, with speakers compared by name.
    expect(second.segments).toEqual(first.segments);

    const a = JSON.parse(firstBytes.toString('utf8')).transcript;
    const b = JSON.parse(secondBytes.toString('utf8')).transcript;

    expect(b.id).not.toBe(a.id);
    expect(b.title).toBe(a.title);
    expect(b.language).toBe(a.language);
    expect(b.durationMs).toBe(a.durationMs);

    // Ids are new on every speaker and segment.
    const firstIds = new Set<string>([...a.speakers, ...a.segments].map((x: { id: string }) => x.id));

    for (const item of [...b.speakers, ...b.segments]) expect(firstIds.has(item.id)).toBe(false);
  });

  it('falls back to createdAt for the recording date when the file has no recordedAt', async () => {
    const seed = await seedTranscript();
    const doc = JSON.parse((await exportJson(seed.transcriptId)).toString('utf8'));

    delete doc.transcript.recordedAt;

    const { transcriptId } = await importService.importFile(user, {
      filename: 'old-export.json',
      body: Buffer.from(JSON.stringify(doc), 'utf8'),
    });
    const imported = await prisma.transcript.findUniqueOrThrow({ where: { id: transcriptId } });

    expect(imported.recordedAt?.toISOString()).toBe(doc.transcript.createdAt);
  });

  it('leaves no transcript, no rows and no stored object behind for a refused file', async () => {
    const before = await prisma.transcript.count({ where: { ownerId } });
    const objectsBefore = await prisma.storageObject.count({ where: { storageKey: { startsWith: 'transcripts/' } } });

    await expect(
      importService.importFile(user, { filename: 'bad.json', body: Buffer.from('{"schema":"kvox.transcript/v2"}') }),
    ).rejects.toMatchObject({ status: 400 });

    expect(await prisma.transcript.count({ where: { ownerId } })).toBe(before);
    expect(await prisma.storageObject.count({ where: { storageKey: { startsWith: 'transcripts/' } } })).toBe(
      objectsBefore,
    );
  });
});

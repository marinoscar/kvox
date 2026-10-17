import { BadRequestException } from '@nestjs/common';

import {
  createFakeKvoxJobs,
  createInMemoryKvoxObjectStore,
  createRecordingKvoxAudit,
} from '../../../src/testing/index.js';
import type { KvoxEventsPort } from '../../../src/ports/index.js';
import { TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT } from '../../../src/transcripts/events/transcript-speakers-identified.event.js';
import { TranscriptImportService } from '../../../src/transcripts/import/transcript-import.service.js';
import { TRANSCRIPT_IMPORT_PROVIDER } from '../../../src/transcripts/import/transcript-import.js';
import {
  createImportRecordingDb,
  importFixtureDocument,
} from '../../../src/transcripts/testing/import-fixtures.js';
import { TranscriptObjectsService } from '../../../src/transcripts/transcript-objects.service.js';
import { resolveTranscriptsOptions } from '../../../src/transcripts/transcripts.options.js';
import type { TranscriptsActor } from '../../../src/transcripts/transcripts-actor.js';

// =============================================================================
// TranscriptImportService over in-memory ports (issue #571). The round trip
// through a real database is `apps/api`'s db spec; this pins the write shape, the
// compensation and what happens after the commit.
// =============================================================================

const USER: TranscriptsActor = {
  id: '11111111-1111-4111-8111-111111111111',
  permissions: ['transcripts:write'],
  activeOrgId: '22222222-2222-4222-8222-222222222222',
};

function build(options: Parameters<typeof createImportRecordingDb>[0] = {}) {
  const recording = createImportRecordingDb(options);
  const store = createInMemoryKvoxObjectStore();
  const jobs = createFakeKvoxJobs();
  const emitted: Array<{ name: string; payload: unknown }> = [];
  const events: KvoxEventsPort = {
    emit: (name, payload) => void emitted.push({ name, payload }),
    subscribe: () => () => undefined,
  };
  const pipeline = { enqueueSnapshot: jest.fn().mockResolvedValue(true), enqueueSearchIndex: jest.fn().mockResolvedValue(undefined) };
  const service = new TranscriptImportService(
    recording.db,
    events,
    createRecordingKvoxAudit(),
    new TranscriptObjectsService(store, resolveTranscriptsOptions({})),
    pipeline as never,
  );

  return { service, recording, store, jobs, emitted, pipeline };
}

function file(value: unknown = importFixtureDocument()) {
  return { filename: 'C:\\exports\\sync.json', body: Buffer.from(JSON.stringify(value)) };
}

describe('TranscriptImportService', () => {
  it('writes a ready transcript, its version 1 and the identity of the named speaker', async () => {
    const { service, recording, store } = build();

    const { transcriptId } = await service.importFile(USER, file());
    const row = recording.transcripts.get(transcriptId)!;

    expect(row).toMatchObject({
      id: transcriptId,
      ownerId: USER.id,
      orgId: USER.activeOrgId,
      title: 'Planning sync',
      status: 'ready',
      transcriptionStatus: 'completed',
      playbackStatus: 'not_needed',
      provider: TRANSCRIPT_IMPORT_PROVIDER,
      currentVersion: 1,
      speakerCount: 2,
      wordCount: 11,
      durationMs: 9_500,
    });
    expect(row.recordedAt.toISOString()).toBe('2026-09-10T14:00:00.000Z');
    expect(row.providerOptions.importedFrom).toEqual({
      schema: 'kvox.transcript/v1',
      sourceTranscriptId: 'tr_source_1',
      sourceVersion: 3,
      sourceProvider: { id: 'assemblyai', model: 'best' },
    });

    const [dana, other] = recording.speakers;

    expect(dana).toMatchObject({ label: 'A', displayName: 'Dana Example', colorIndex: 0 });
    expect(other).toMatchObject({ label: 'B', displayName: 'Speaker B', colorIndex: 1 });
    expect(row.speakerIdentities).toEqual({ [dana.id]: 'Dana Example' });
    expect(recording.segments.map((s) => s.speakerId)).toEqual([dana.id, other.id, dana.id]);
    expect(recording.versions).toEqual([
      expect.objectContaining({ version: 1, kind: 'ai_original', authorId: null, ops: [] }),
    ]);

    const source = store.objects.get(row.sourceObjectId)!;

    expect(source).toMatchObject({ managedBy: 'transcripts', mimeType: 'application/json', name: 'sync.json' });
    expect(source.key).toMatch(new RegExp(`^transcripts/${transcriptId}/source/[0-9a-f-]{36}\\.json$`));
  });

  it('queues the snapshot and the search index, and tells the graph about the named speaker', async () => {
    const { service, recording, pipeline, emitted } = build();

    const { transcriptId } = await service.importFile(USER, file());

    expect(pipeline.enqueueSnapshot).toHaveBeenCalledWith(transcriptId, 1);
    expect(pipeline.enqueueSearchIndex).toHaveBeenCalledWith(transcriptId);
    expect(emitted).toEqual([
      {
        name: TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT,
        payload: expect.objectContaining({ transcriptId, actorUserId: USER.id, speakerIds: [recording.speakers[0].id] }),
      },
    ]);
  });

  it('emits no naming event when every speaker is on its placeholder', async () => {
    const { service, emitted, recording } = build();
    const doc = importFixtureDocument();

    doc.transcript.speakers[0].displayName = 'Speaker A';

    const { transcriptId } = await service.importFile(USER, file(doc));

    expect(emitted).toEqual([]);
    expect(recording.transcripts.get(transcriptId)!.speakerIdentities).toEqual({});
  });

  it('answers a refused file with a 400 carrying details.reason, and stores nothing', async () => {
    const { service, store, recording } = build();

    const error = await service.importFile(USER, file({ nodes: [] })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ details: { reason: 'unsupported_schema' } });
    expect(store.objects.size).toBe(0);
    expect(recording.transcripts.size).toBe(0);
  });

  it('deletes the stored file again when the transaction fails', async () => {
    const { service, store } = build({ failOn: 'segments' });

    await expect(service.importFile(USER, file())).rejects.toThrow('segments write refused');
    expect(store.objects.size).toBe(0);
  });
});

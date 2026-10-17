// =============================================================================
// `media.audio.transcode` against the platform handler contract (issue #468)
// =============================================================================
//
// `describeJobHandlerConformance` (`@marinoscar/platform-api/jobs/testing`) holds a
// handler to the contract every job type shares: a dotted type, a label, a
// two-number profile, node eligibility derived from the schema/persist pair,
// a settle through the queue, an idempotent second run, failure by throwing and
// the dedup rule. This type is one of the two NODE-ELIGIBLE KVox types, so the
// static half also proves it carries BOTH `nodeResultSchema` and
// `persistNodeResult`.
//
// The behavioural detail of the handler (server and node paths writing the same
// rows, the bitrate rules, the last-attempt failure policy) stays in
// `transcripts/handlers/media-audio-transcode.handler.spec.ts`. This file is the
// contract; that one is the behaviour.
//
// The world is a small STATEFUL fake (a transcript row the handler updates), so
// the idempotency case is a real comparison: the second run must find the
// rendition already recorded and leave everything as the first run left it.
// =============================================================================

import { Test } from '@nestjs/testing';
import { writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';

import { JobHandlerRegistry, type JobHandler } from '@marinoscar/platform-api/jobs';
import { describeJobHandlerConformance } from '@marinoscar/platform-api/jobs/testing';
import { KVOX_JOBS, KVOX_OBJECT_STORE, KVOX_PRISMA } from '@marinoscar/kvox-api/ports';
import {
  FfmpegService,
  MediaAudioTranscodeHandler,
  TranscriptObjectsService,
  TranscriptPipelineService,
  TranscriptionRuntimeService,
} from '@marinoscar/kvox-api/transcripts';

import { createKvoxJobsHarness, platformHandlerOf } from '../helpers/kvox-handler.helper';

const TRANSCRIPT_ID = 'transcript-1';
const OBJECT_ID = 'obj-1';

type Mode = 'ok' | 'probe-fails';

/** One fresh fake world per test, so no state leaks between cases. */
interface World {
  handler: JobHandler;
  transcript: Record<string, unknown>;
  uploads: string[];
  recorded: string[];
}

let mode: Mode = 'ok';
let world: World;

async function buildWorld(): Promise<JobHandler> {
  const transcript: Record<string, unknown> = {
    id: TRANSCRIPT_ID,
    ownerId: 'user-1',
    title: 'A recording',
    status: 'processing',
    transcriptionStatus: 'waiting_input',
    playbackStatus: 'processing',
    sourceObjectId: OBJECT_ID,
    playbackObjectId: null,
    durationMs: null,
    deletedAt: null,
  };
  const uploads: string[] = [];
  const recorded: string[] = [];

  const prisma = {
    transcript: {
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(transcript, data)),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ transcriptionStatus: 'waiting_input', status: 'processing' }),
    },
  };

  // The source object, as the store port describes it.
  const store = {
    describe: jest.fn().mockResolvedValue(
      new Map([
        [
          OBJECT_ID,
          {
            id: OBJECT_ID,
            name: 'a.wav',
            mimeType: 'audio/wav',
            size: 10_000_000,
            state: 'ready',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      ]),
    ),
    signedDownloadUrl: jest.fn().mockResolvedValue('https://bucket.example/signed'),
  };

  const ffmpeg = {
    probe:
      mode === 'probe-fails'
        ? jest.fn().mockRejectedValue(new Error('ffprobe exploded'))
        : jest.fn().mockResolvedValue({
            durationMs: 75_264,
            codec: 'pcm_s16le',
            channels: 2,
            bitrateKbps: 1411,
            formatName: 'wav',
          }),
    transcode: jest.fn(async ({ output }: { output: string }) => {
      writeFileSync(output, Buffer.alloc(4096, 7));
    }),
  };

  // The server path stores and records in one streamed call; the node path records bytes a node put.
  const objects = {
    putStream: jest.fn((input: { storageKey: string }) => {
      uploads.push(input.storageKey);
      recorded.push(input.storageKey);

      const body = new PassThrough();
      let size = 0;
      const done = new Promise<{ id: string; size: number }>((resolve) => {
        body.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
        });
        body.on('end', () => resolve({ id: 'rendition-1', size }));
      });

      return { body, done };
    }),
    recordUploaded: jest.fn(async (input: { storageKey: string }) => {
      recorded.push(input.storageKey);

      return { id: 'rendition-1' };
    }),
  };

  const pipeline = {
    loadForJob: jest.fn(async () => transcript),
    markFailed: jest.fn().mockResolvedValue(true),
    enqueueSubmit: jest.fn().mockResolvedValue(undefined),
  };

  const runtime = {
    policy: jest.fn().mockResolvedValue({ transcodeNodeOffloadEnabled: true, playback: { bitrateKbps: 96 } }),
    activeProvider: jest.fn().mockResolvedValue({ provider: { capabilities: { maxDurationMs: 10 * 60 * 60_000 } }, policy: {} }),
  };

  // The handler registers itself through the web edition's jobs adapter, as at boot; the platform
  // contract is held against what the registry then holds.
  const harness = createKvoxJobsHarness();

  const module = await Test.createTestingModule({
    providers: [
      MediaAudioTranscodeHandler,
      { provide: KVOX_JOBS, useValue: harness.adapter },
      { provide: KVOX_OBJECT_STORE, useValue: store },
      { provide: KVOX_PRISMA, useValue: prisma },
      { provide: FfmpegService, useValue: ffmpeg },
      { provide: TranscriptObjectsService, useValue: objects },
      { provide: TranscriptPipelineService, useValue: pipeline },
      { provide: TranscriptionRuntimeService, useValue: runtime },
    ],
  }).compile();

  const handler = platformHandlerOf(harness, module.get(MediaAudioTranscodeHandler));

  world = { handler, transcript, uploads, recorded };

  return handler;
}

/** Everything the handler wrote, in a comparable shape. */
function observe(): unknown {
  return {
    playbackStatus: world.transcript.playbackStatus,
    playbackObjectId: world.transcript.playbackObjectId,
    durationMs: world.transcript.durationMs,
    uploads: [...world.uploads],
    recorded: [...world.recorded],
  };
}

beforeEach(() => {
  mode = 'ok';
});

describeJobHandlerConformance('media.audio.transcode', buildWorld, {
  payloads: [
    {
      name: 'a transcript waiting on its rendition',
      payload: { transcriptId: TRANSCRIPT_ID, bitrateKbps: 96 },
      subjectType: 'storage_object',
      subjectId: OBJECT_ID,
      // User-triggered jobs that touch `storage_objects` are enqueued with an organization.
      orgId: 'org-1',
      arrange: () => {
        mode = 'ok';
      },
      observe,
    },
    {
      name: 'a source ffprobe cannot read',
      payload: { transcriptId: TRANSCRIPT_ID, bitrateKbps: 96 },
      subjectType: 'storage_object',
      subjectId: OBJECT_ID,
      // User-triggered jobs that touch `storage_objects` are enqueued with an organization.
      orgId: 'org-1',
      arrange: () => {
        mode = 'probe-fails';
      },
      expectFailure: 'ffprobe exploded',
    },
  ],
});

describe('media.audio.transcode node eligibility (derived, never declared)', () => {
  it('carries both members that make the type node-eligible', async () => {
    const handler = await buildWorld();

    expect(handler.nodeResultSchema).toBeDefined();
    expect(typeof handler.persistNodeResult).toBe('function');
  });

  it('is absent from the registry server-only list', async () => {
    const handler = await buildWorld();
    const registry = new JobHandlerRegistry();

    registry.register(handler);

    expect(registry.types()).toContain('media.audio.transcode');
    expect(registry.serverOnlyTypes()).not.toContain('media.audio.transcode');
  });
});

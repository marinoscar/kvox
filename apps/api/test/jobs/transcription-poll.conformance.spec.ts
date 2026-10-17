// =============================================================================
// `transcription.poll` against the platform handler contract (issue #468)
// =============================================================================
//
// `transcription.poll` is a SELF-CHAINING job: each poll that finds the
// provider still working queues the next one, delayed on a backoff schedule,
// while it is itself still `running`. Under the queue's active-dedup rule that
// second enqueue would collapse onto the running row, schedule no backoff and
// leave the transcript in `submitted` forever, so the re-enqueue carries
// `skipDedup: true` (`TranscriptPipelineService.enqueuePoll`).
//
// Two things are pinned here, both through the platform's in-memory queue
// (`createFakeJobQueue`), which implements the real dedup rule:
//
//   1. The shared handler contract, via `describeJobHandlerConformance`. Its
//      dedup case proves the helper's own premise (the same subject queued
//      twice is one job, `skipDedup` is two) for this type's subject.
//   2. The chain itself: the handler's own re-enqueue, made by the REAL
//      `enqueuePoll`, lands as a SECOND pending row while the first is running.
//      Drop `skipDedup` and this fails.
//
// The pipeline is a stub except for `enqueuePoll`, which is the real method
// run against the fake queue. It needs only `this.jobs`, so no other
// collaborator is built.
// =============================================================================

import { Test } from '@nestjs/testing';

import { type JobHandler } from '@marinoscar/platform-api/jobs';
import { createFakeJobQueue, describeJobHandlerConformance, type FakeJobQueue } from '@marinoscar/platform-api/jobs/testing';
import { KVOX_JOBS, KVOX_PRISMA } from '@marinoscar/kvox-api/ports';
import {
  TranscriptPipelineService,
  TranscriptionPollHandler,
  TranscriptionRuntimeService,
} from '@marinoscar/kvox-api/transcripts';

import { createKvoxJobsHarness, platformHandlerOf } from '../helpers/kvox-handler.helper';

const TRANSCRIPT_ID = 'transcript-1';

type Mode = 'processing' | 'completed' | 'network-down';

let mode: Mode = 'processing';
let currentQueue: FakeJobQueue | undefined;
let row: Record<string, unknown>;
let ingests: number;
let failures: number;

/** The queue the handler's re-enqueue goes to: whichever the running case built. */
function queue(): FakeJobQueue {
  currentQueue ??= createFakeJobQueue();

  return currentQueue;
}

async function buildWorld(): Promise<JobHandler> {
  const now = new Date();

  row = {
    id: TRANSCRIPT_ID,
    ownerId: 'user-1',
    title: 'A recording',
    status: 'processing',
    transcriptionStatus: 'submitted',
    providerJobId: 'remote-1',
    durationMs: null,
    deletedAt: null,
    createdAt: now,
    submittedAt: now,
  };
  ingests = 0;
  failures = 0;

  // The poll asks the provider one question: is it finished?
  const provider = { getStatus: jest.fn().mockResolvedValue(mode === 'completed' ? 'completed' : 'processing') };

  const prisma = {
    transcript: {
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(row, data)),
    },
  };

  const pipeline = {
    loadForJob: jest.fn(async () => row),
    markFailed: jest.fn(async () => {
      failures += 1;

      return true;
    }),
    enqueueIngest: jest.fn(async () => {
      ingests += 1;
    }),
    // The REAL method, on the fake queue: this is what carries `skipDedup`.
    enqueuePoll: (transcriptId: string, delayMs: number, reason?: 'upload' | 'rerun') =>
      TranscriptPipelineService.prototype.enqueuePoll.call(
        { jobs: createKvoxJobsHarness(queue().asJobsService()).adapter },
        transcriptId,
        delayMs,
        reason,
      ),
  };

  const runtime = {
    resolve:
      mode === 'network-down'
        ? jest.fn().mockRejectedValue(new Error('settings database unreachable'))
        : jest.fn().mockResolvedValue({ provider, ctx: { apiKey: 'k' }, policy: {} }),
  };

  // The handler registers itself through the web edition's jobs adapter, as at boot; the platform
  // contract is held against what the registry then holds.
  const harness = createKvoxJobsHarness(queue().asJobsService());

  const module = await Test.createTestingModule({
    providers: [
      TranscriptionPollHandler,
      { provide: KVOX_JOBS, useValue: harness.adapter },
      { provide: KVOX_PRISMA, useValue: prisma },
      { provide: TranscriptionRuntimeService, useValue: runtime },
      { provide: TranscriptPipelineService, useValue: pipeline },
    ],
  }).compile();

  return platformHandlerOf(harness, module.get(TranscriptionPollHandler));
}

beforeEach(() => {
  mode = 'processing';
  currentQueue = undefined;
});

const SUBJECT = { subjectType: 'transcript', subjectId: TRANSCRIPT_ID } as const;

describeJobHandlerConformance('transcription.poll', buildWorld, {
  // The helper builds one queue per case; the handler's re-enqueue must go to it.
  createQueue: () => {
    currentQueue = createFakeJobQueue();

    return currentQueue;
  },
  payloads: [
    {
      name: 'the provider is still working',
      payload: { transcriptId: TRANSCRIPT_ID, delayMs: 30_000 },
      ...SUBJECT,
      arrange: () => {
        mode = 'processing';
      },
      observe: () => ({ status: row.transcriptionStatus, failures }),
      // A poll that finds work in progress queues the next poll BY DESIGN, so
      // the second run adds a row; what must not change is the transcript.
      assertIdempotent: ({ afterFirst, afterSecond }, expect) => {
        expect(afterSecond).toEqual(afterFirst);
      },
    },
    {
      name: 'the provider has finished',
      payload: { transcriptId: TRANSCRIPT_ID, delayMs: 30_000 },
      ...SUBJECT,
      arrange: () => {
        mode = 'completed';
      },
      // The second run finds `completed` and ends the chain: one ingest, not two.
      observe: () => ({ status: row.transcriptionStatus, ingests, failures }),
    },
    {
      name: 'the provider settings cannot be read',
      payload: { transcriptId: TRANSCRIPT_ID, delayMs: 30_000 },
      ...SUBJECT,
      arrange: () => {
        mode = 'network-down';
      },
      expectFailure: 'settings database unreachable',
    },
  ],
});

describe('transcription.poll self-chain through the queue dedup rule', () => {
  it('queues the next poll while its own job is still running (skipDedup)', async () => {
    mode = 'processing';

    const handler = await buildWorld();
    const polls = queue();

    polls.register(handler);
    await polls.enqueue({
      type: 'transcription.poll',
      reason: 'upload',
      ...SUBJECT,
      payload: { transcriptId: TRANSCRIPT_ID, delayMs: 30_000 },
      orgId: null,
    });

    const run = await polls.runNext();

    expect(run?.outcome).toBe('succeeded');

    const chain = polls.jobs({ type: 'transcription.poll' });

    // One settled, one waiting. Without `skipDedup` the enqueue returns the
    // running row and the chain silently ends.
    expect(chain).toHaveLength(2);
    expect(chain.map((job) => job.status).sort()).toEqual(['pending', 'succeeded']);
  });

  it('still deduplicates an ordinary double enqueue of the same transcript', async () => {
    const polls = queue();
    const input = {
      type: 'transcription.poll',
      reason: 'upload' as const,
      ...SUBJECT,
      payload: { transcriptId: TRANSCRIPT_ID, delayMs: 30_000 },
      orgId: null,
    };

    const first = await polls.enqueue(input);
    const second = await polls.enqueue(input);

    expect(second.id).toBe(first.id);
    expect(polls.jobs({ type: 'transcription.poll' })).toHaveLength(1);
  });
});

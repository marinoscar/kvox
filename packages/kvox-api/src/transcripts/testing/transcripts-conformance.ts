import { createFakeKvoxJobs } from '../../testing/index.js';
import type { KvoxJobHandler, KvoxJobsPort } from '../../ports/index.js';

// =============================================================================
// The transcripts slice's conformance suite (issue #493, epic #491)
// =============================================================================
//
// `describeTranscriptsConformance` states the pipeline invariants a binding must keep,
// in the form a host runs against ITS wiring: the handlers it registered, and the
// pipeline it built over its job port. The package runs it over the fake ports; the web
// application runs it over its own binding in `apps/api/test/conformance.spec.ts`.
//
// THE INVARIANTS, each of them the cause of an outage or a leak when it is broken:
//
//   1. THE POLL RE-ENQUEUE PASSES `skipDedup: true`. The active-dedup index is keyed on
//      `(type, subject)` and the poll job calling `enqueuePoll` is `running` right now, so
//      it matches that key itself. Without `skipDedup` the enqueue collapses into the
//      running row, the new delay is discarded, and the transcript sits in `submitted`
//      forever with no error anywhere. The kit uses the fake queue's own dedup rule (do not
//      "simplify" it) to prove the second job is distinct work.
//   2. `transcript.name_check` IS SERVER-ONLY AND TRIED ONCE. It spends the requester's own
//      key, which no vendor lets a node hold (no `nodeResultSchema`), and a completion is
//      non-deterministic, so a retry would bill for text nobody asked to see twice
//      (`maxAttempts: 1`).
//   3. `media.audio.transcode` IS NODE-ELIGIBLE: both members that derive eligibility.
//   4. EVERY OTHER TYPE IS SERVER-ONLY: the provider pipeline holds the deployment's key,
//      an export's renderers live in the API, a purge and a sweep write as they go.
//   5. EVERY JOB TYPE STRING IS THE PINNED ONE. A type string is permanent once jobs of it
//      exist; this list is written out here, not imported, so a rename fails this test.
// =============================================================================

/**
 * The test runner's functions, so the kit runs under Jest or Vitest.
 *
 * @stability experimental
 */
export interface TranscriptsConformanceHarness {
  /** Opens a group of tests. */
  describe(name: string, fn: () => void): void;
  /** Declares one test. */
  it(name: string, fn: (...args: any[]) => any): void;
  /** Starts an assertion. */
  expect(actual: any): any;
}

/**
 * The one call of the pipeline service the kit makes.
 *
 * @stability experimental
 */
export interface TranscriptsConformancePipeline {
  /**
   * Queues the next link of a transcript's poll chain.
   *
   * @param transcriptId - the transcript.
   * @param delayMs - how long to wait before polling.
   */
  enqueuePoll(transcriptId: string, delayMs: number): Promise<void>;
}

/**
 * What the kit needs from the binding under test.
 *
 * @stability experimental
 */
export interface TranscriptsConformanceTarget {
  /** Every job handler the slice registered, as the host registers them. */
  handlers: readonly KvoxJobHandler[];

  /**
   * The slice's pipeline service built over the given job port.
   *
   * @param jobs - the port to enqueue on.
   */
  pipelineFor(jobs: KvoxJobsPort): TranscriptsConformancePipeline;
}

/** The nine job types the slice owns. Written out on purpose; see the header. */
const PINNED_JOB_TYPES = [
  'media.audio.transcode',
  'transcript.export',
  'transcript.name_check',
  'transcript.purge',
  'transcript.snapshot',
  'transcription.ingest',
  'transcription.poll',
  'transcription.submit',
  'transcripts.housekeeping',
] as const;

/** The node-eligible one. */
const NODE_ELIGIBLE = 'media.audio.transcode';

/**
 * Declares the transcripts conformance tests.
 *
 * @param name - the name of the group (the binding under test).
 * @param build - builds the target; called once, on the first test. May be asynchronous, so a
 *   host can boot its application module first.
 * @param harness - the runner's `describe`, `it` and `expect`.
 * @stability experimental
 */
export function describeTranscriptsConformance(
  name: string,
  build: () => TranscriptsConformanceTarget | Promise<TranscriptsConformanceTarget>,
  harness: TranscriptsConformanceHarness,
): void {
  const { describe, it, expect } = harness;

  describe(`transcripts conformance: ${name}`, () => {
    let built: Promise<TranscriptsConformanceTarget> | undefined;

    const targetOf = (): Promise<TranscriptsConformanceTarget> => (built ??= Promise.resolve(build()));

    // The slice's own types by name: a host passes every handler it registered, which also
    // holds the other slices'. A new `transcript.*` / `transcription.*` type is caught here.
    const owned = (handler: KvoxJobHandler): boolean =>
      handler.type.startsWith('transcript') || handler.type === NODE_ELIGIBLE;

    const handlersOf = async (): Promise<Map<string, KvoxJobHandler>> =>
      new Map((await targetOf()).handlers.filter(owned).map((handler) => [handler.type, handler]));

    it('registers exactly the nine pinned job types', async () => {
      const target = await targetOf();
      const byType = await handlersOf();

      expect([...byType.keys()].sort()).toEqual([...PINNED_JOB_TYPES].sort());
      expect(target.handlers.filter(owned).length).toBe(PINNED_JOB_TYPES.length);
    });

    it('re-enqueues a poll with skipDedup, so it is never merged into the running poll', async () => {
      const jobs = createFakeKvoxJobs();
      const pipeline = (await targetOf()).pipelineFor(jobs);
      const transcriptId = '99999999-9999-4999-8999-999999999999';

      // The chain's current link, as the queue holds it while it runs.
      await jobs.enqueue({
        type: 'transcription.poll',
        subjectType: 'transcript',
        subjectId: transcriptId,
        payload: { transcriptId, delayMs: 5_000 },
        skipDedup: true,
      });

      await pipeline.enqueuePoll(transcriptId, 10_000);

      const polls = jobs.jobs.filter((job) => job.input.type === 'transcription.poll');

      expect(polls.length).toBe(2);
      expect(polls[1].input.skipDedup).toBe(true);
      expect(polls[1].input.subjectId).toBe(transcriptId);
      expect(polls[1].input.scheduledFor).toBeInstanceOf(Date);
    });

    it('keeps transcript.name_check server-only and tries it once', async () => {
      const byType = await handlersOf();
      const handler = byType.get('transcript.name_check');

      expect(handler).toBeDefined();
      expect(handler?.profile?.maxAttempts).toBe(1);
      expect(handler?.nodeResultSchema).toBeUndefined();
      expect(handler?.persistNodeResult).toBeUndefined();
      expect(handler?.usesAi).toBe(true);
    });

    it('keeps media.audio.transcode node-eligible: both members', async () => {
      const handler = (await handlersOf()).get(NODE_ELIGIBLE);

      expect(handler?.nodeResultSchema).toBeDefined();
      expect(typeof handler?.persistNodeResult).toBe('function');
      expect(typeof handler?.deriveOutputKey).toBe('function');
    });

    it('keeps every other type server-only', async () => {
      for (const handler of (await targetOf()).handlers.filter(owned)) {
        if (handler.type === NODE_ELIGIBLE) continue;

        expect({ type: handler.type, node: handler.nodeResultSchema !== undefined }).toEqual({
          type: handler.type,
          node: false,
        });
        expect({ type: handler.type, node: handler.persistNodeResult !== undefined }).toEqual({
          type: handler.type,
          node: false,
        });
      }
    });

    it('puts the three provider-facing types on the one transcription bucket', async () => {
      const byType = await handlersOf();

      for (const type of ['transcription.submit', 'transcription.poll', 'transcription.ingest']) {
        expect({ type, key: byType.get(type)?.throttleKey }).toEqual({ type, key: 'transcription-provider' });
      }
    });
  });
}

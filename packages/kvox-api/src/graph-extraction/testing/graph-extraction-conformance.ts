import { KG_EMBED_JOB_TYPE, KG_EXTRACT_JOB_TYPE, KG_RESOLVE_JOB_TYPE, KG_TOPICS_PROMOTE_JOB_TYPE, rethrowRateLimit } from '../../graph/index.js';
import { NOTE_READY_EVENT } from '../../notes/index.js';
import { KvoxAiError, KvoxRateLimitError, type KvoxJob, type KvoxJobHandler } from '../../ports/index.js';
import { createInMemoryKvoxEvents } from '../../testing/index.js';
import { KgEmbedHandler } from '../handlers/kg-embed.handler.js';
import { NoteReadyExtractionSubscriber } from '../extraction/note-ready-extraction.subscriber.js';
import { ProposalStageRegistry, type ProposalStage } from '../extraction/proposal-stage.js';

// =============================================================================
// The graph-extraction conformance suite (issue #496, epic #491)
// =============================================================================
//
// `describeGraphExtractionConformance` states, once, the invariants of the extraction, resolution and
// proposal pipeline that a host's binding must not break and a fork that changes the slice must keep:
//
//   • the job types and their execution posture: `kg.extract` and `kg.resolve` are tried ONCE (a retry
//     would re-spend the owner's key on rows already written), `kg.embed` is retry-safe (three attempts),
//     and all three spend the owner's own AI key, so none can ever be offered to a worker node;
//   • a provider rate limit defers THAT USER's work only: it leaves as a `KvoxRateLimitError` on the
//     per-user bucket `ai-provider:<userId>`, never a shared one;
//   • a `sensitive` PersonFact is never embedded, and a stale vector on one is cleared;
//   • a ready note reaches the graph through the event port alone (`kvox.notes.note_ready`), and the
//     subscriber only enqueues;
//   • the proposal stages run in their declared order.
// =============================================================================

/**
 * The test runner's functions, so the suite runs under Jest or Vitest.
 *
 * @stability experimental
 */
export interface GraphExtractionConformanceHarness {
  /** Opens a group of tests. */
  describe(name: string, fn: () => void): void;
  /** Declares one test. */
  it(name: string, fn: (...args: any[]) => any): void;
  /** Starts an assertion. */
  expect(actual: any): any;
}

/**
 * What the suite needs from a host's binding.
 *
 * @stability experimental
 */
export interface GraphExtractionConformanceTarget {
  /** Every job handler the binding registered (the extraction types are picked out by name). */
  handlers: readonly KvoxJobHandler[];
}

const PINNED_TYPES = [
  { type: KG_EXTRACT_JOB_TYPE, maxRuntimeMs: 20 * 60_000, maxAttempts: 1 },
  { type: KG_RESOLVE_JOB_TYPE, maxRuntimeMs: 20 * 60_000, maxAttempts: 1 },
  { type: KG_EMBED_JOB_TYPE, maxRuntimeMs: 5 * 60_000, maxAttempts: 3 },
  // #666 — every proposal is written whole, so a retry only skips what is already proposed.
  { type: KG_TOPICS_PROMOTE_JOB_TYPE, maxRuntimeMs: 30 * 60_000, maxAttempts: 3 },
] as const;

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOTE = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';

/** A `kg.embed` handler over a recording embedder and one sensitive PersonFact holding a stale vector. */
function embedScenario() {
  const executed: unknown[] = [];
  const embedded: string[][] = [];
  const prisma = {
    kgEntity: { findMany: async () => [] },
    kgEntityAlias: { findMany: async () => [] },
    kgRelation: { findMany: async () => [] },
    kgItem: {
      findMany: async () => [
        {
          id: ITEM,
          kind: 'person_fact',
          title: 'x',
          statement: 'SECRET-PRIVATE-FACT',
          sensitivity: 'sensitive',
          subjectId: null,
          embeddingHash: 'stale',
        },
      ],
    },
    $queryRaw: async () => [],
    $executeRaw: async (...args: unknown[]) => {
      executed.push(args);
      return 1;
    },
    $transaction: async (ops: unknown[]) => ops,
  };
  const embedder = {
    resolve: async () => ({
      ok: true,
      providerId: 'openai',
      model: 'text-embedding-3-small',
      maxBatchSize: 128,
      embed: async (texts: string[]) => {
        embedded.push(texts);
        return texts.map(() => []);
      },
    }),
  };
  const jobs = { registerHandler: () => undefined };
  const handler = new KgEmbedHandler(jobs as never, prisma as never, embedder as never);

  return { handler, embedded, executed };
}

/**
 * Registers the graph-extraction conformance suite.
 *
 * @param label - names the binding under test in the report.
 * @param setup - resolves the host's binding (the registered handlers).
 * @param harness - the runner's `describe`, `it` and `expect`.
 * @stability experimental
 */
export function describeGraphExtractionConformance(
  label: string,
  setup: () => Promise<GraphExtractionConformanceTarget> | GraphExtractionConformanceTarget,
  harness: GraphExtractionConformanceHarness,
): void {
  const { describe, it, expect } = harness;

  describe(`graph-extraction conformance: ${label}`, () => {
    describe('job types', () => {
      let handlers: readonly KvoxJobHandler[] = [];

      it('resolves the binding', async () => {
        handlers = (await setup()).handlers;
      });

      for (const pinned of PINNED_TYPES) {
        it(`${pinned.type} is registered, server-only, spends the owner's key, with its pinned profile`, () => {
          const handler = handlers.find((candidate) => candidate.type === pinned.type);

          expect(handler).toBeDefined();
          expect(handler?.usesAi).toBe(true);
          expect(handler?.nodeResultSchema).toBeUndefined();
          expect(handler?.persistNodeResult).toBeUndefined();
          expect(handler?.profile).toEqual({ maxRuntimeMs: pinned.maxRuntimeMs, maxAttempts: pinned.maxAttempts });
        });
      }
    });

    describe('rate limits', () => {
      it('defer one user on their own throttle bucket and nobody else', () => {
        const keyFor = (userId: string): string => {
          try {
            rethrowRateLimit(new KvoxAiError('rate_limit', 'slow down', 1000), userId);
          } catch (error) {
            return (error as KvoxRateLimitError).throttleKey;
          }
          return '';
        };

        expect(keyFor(USER)).toBe(`ai-provider:${USER}`);
        expect(keyFor(OTHER)).toBe(`ai-provider:${OTHER}`);
        expect(keyFor(USER)).not.toBe(keyFor(OTHER));
      });

      it('lets a non-rate-limit failure through untouched', () => {
        expect(() => rethrowRateLimit(new KvoxAiError('auth', 'refused'), USER)).not.toThrow();
        expect(() => rethrowRateLimit(new KvoxRateLimitError('ai-provider:x', 5), USER)).toThrow(KvoxRateLimitError);
      });
    });

    describe('a sensitive PersonFact is never embedded', () => {
      it('sends nothing to the embedder and clears the stale vector', async () => {
        const { handler, embedded, executed } = embedScenario();
        const job = { id: 'job-1', payload: { userId: USER, subjectKind: 'item', ids: [ITEM] } } as unknown as KvoxJob;

        await handler.process(job);

        expect(JSON.stringify(embedded)).not.toContain('SECRET-PRIVATE-FACT');
        expect(embedded).toEqual([]);
        expect(executed).toHaveLength(1);
      });
    });

    describe('the hand-off from a ready note', () => {
      it('the subscriber enqueues through the extraction service on kvox.notes.note_ready and does nothing else', async () => {
        const events = createInMemoryKvoxEvents();
        const calls: Array<[string, string]> = [];
        const extraction = {
          enqueueForReadyNote: async (noteId: string, ownerId: string) => {
            calls.push([noteId, ownerId]);
            return null;
          },
        };

        new NoteReadyExtractionSubscriber(events, extraction as never).onModuleInit();
        events.emit(NOTE_READY_EVENT, { noteId: NOTE, ownerId: USER });
        await new Promise((resolve) => setImmediate(resolve));

        expect(calls).toEqual([[NOTE, USER]]);
      });

      it('a failing enqueue is swallowed (the note is already committed and ready)', async () => {
        const events = createInMemoryKvoxEvents();
        const extraction = {
          enqueueForReadyNote: async () => {
            throw new Error('database went away');
          },
        };

        new NoteReadyExtractionSubscriber(events, extraction as never).onModuleInit();

        expect(() => events.emit(NOTE_READY_EVENT, { noteId: NOTE, ownerId: USER })).not.toThrow();
        await new Promise((resolve) => setImmediate(resolve));
      });
    });

    describe('the proposal stages', () => {
      it('run in their declared order, whatever the order they registered in', () => {
        const stage = (name: string, order: number): ProposalStage => ({ name, order, run: async () => undefined });
        const registry = new ProposalStageRegistry();

        registry.register(stage('temporal-closing', 300));
        registry.register(stage('resolution', 100));
        registry.register(stage('work-item-dedup', 200));

        expect(registry.ordered().map((entry) => entry.name)).toEqual(['resolution', 'work-item-dedup', 'temporal-closing']);
      });
    });
  });
}

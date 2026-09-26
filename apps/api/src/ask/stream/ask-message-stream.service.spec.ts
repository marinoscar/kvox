import { firstValueFrom, toArray } from 'rxjs';

import type { PrismaService } from '../../prisma/prisma.service';
import { STREAM_DURATION_CAP_MARGIN_MS } from '../../notes/generation/note-generation-stream.service';
import type { AskCitation, AskToolCall } from '../dto/ask.dto';
import {
  ASK_RESPOND_STREAM_RUNTIME_MS,
  AskMessageStreamService,
  DEFAULT_ASK_STREAM_DURATION_CAP_MS,
  type AskStreamTuning,
} from './ask-message-stream.service';
import type { AskStreamMessage } from './ask-stream';

// =============================================================================
// The Ask reader's loop (issue #379, epic #348)
// =============================================================================
//
// Mirrors `note-generation-stream.service.spec.ts`: no fake timers, intervals
// driven to a millisecond through the tuning, the duration cap on an INJECTED
// clock. Rows are scripted poll by poll in the exact shapes `ask.respond`
// (#378) writes them — `pending`, then `streaming` with `tool_calls` growing by
// one entry per tool and `content` growing by whole flushes, then `complete`
// (with citations/tokens/finish reason) or `failed` (with `error_class`).
// =============================================================================

/** An `ask_messages` row as the poll's narrow `select` returns it. */
interface Row {
  status: 'pending' | 'streaming' | 'complete' | 'failed';
  content: string;
  toolCalls: unknown;
  citations: unknown;
  promptTokens: number | null;
  completionTokens: number | null;
  errorClass: string | null;
  finishReason: string | null;
}

const row = (overrides: Partial<Row> = {}): Row => ({
  status: 'streaming',
  content: '',
  toolCalls: [],
  citations: [],
  promptTokens: null,
  completionTokens: null,
  errorClass: null,
  finishReason: null,
  ...overrides,
});

const tool = (index: number, summary = `Step ${index}`): AskToolCall => ({
  index,
  name: index % 2 === 0 ? 'search' : 'get_entity',
  arguments: { q: 'Acme' },
  summary,
  resultCount: index + 1,
  durationMs: 12,
  error: null,
});

const CITATION: AskCitation = {
  marker: 'ev1',
  kind: 'evidence',
  id: '11111111-1111-4111-8111-111111111111',
  via: null,
  valid: true,
  label: 'Weekly sync',
  documentKind: null,
  startMs: null,
};

/**
 * The write sequence `ask.respond` (#378) produces for one turn: pending, a
 * `streaming` row per recorded tool step, a `streaming` row per content flush,
 * then the terminal row. A test double for the job, not a copy of it.
 */
function respondRows(answer: string, flushAt: number[], stepCount: number, terminal: Partial<Row>): Row[] {
  const steps = Array.from({ length: stepCount }, (_, i) => tool(i));
  const rows: Row[] = [row({ status: 'pending' }), row({ status: 'streaming' })];
  for (let i = 1; i <= stepCount; i += 1) rows.push(row({ toolCalls: steps.slice(0, i) }));
  for (const at of flushAt) rows.push(row({ toolCalls: steps, content: answer.slice(0, at) }));
  rows.push(row({ toolCalls: steps, content: answer, ...terminal }));
  return rows;
}

/** A Prisma stand-in answering one scripted row per poll; the last one repeats. */
function scripted(rows: (Row | null)[]): { prisma: PrismaService; calls: () => number; findUnique: jest.Mock } {
  let index = 0;
  const findUnique = jest.fn(async () => {
    const value = rows[Math.min(index, rows.length - 1)];
    index += 1;
    return value;
  });
  return {
    prisma: { askMessage: { findUnique } } as unknown as PrismaService,
    calls: () => findUnique.mock.calls.length,
    findUnique,
  };
}

const FAST: Partial<AskStreamTuning> = { pollIntervalMs: 1, heartbeatIntervalMs: 10_000, durationCapMs: 10_000 };

const service = (prisma: PrismaService, tuning: Partial<AskStreamTuning> = {}): AskMessageStreamService =>
  new AskMessageStreamService(prisma, { ...FAST, ...tuning });

const collect = (stream: AskMessageStreamService, from = 0, id = 'msg-1'): Promise<AskStreamMessage[]> =>
  firstValueFrom(stream.stream(id, from).pipe(toArray()));

const frames = (messages: AskStreamMessage[]) => messages.filter((m) => m.comment === undefined);
const comments = (messages: AskStreamMessage[]) =>
  messages.filter((m) => m.comment !== undefined).map((m) => m.comment as string);
const deltas = (messages: AskStreamMessage[]) =>
  frames(messages)
    .filter((m) => m.type === 'delta')
    .map((m) => (m.data as { delta: string }).delta);
const stepIndexes = (messages: AskStreamMessage[]) =>
  frames(messages)
    .filter((m) => m.type === 'step')
    .map((m) => (m.data as { index: number }).index);

/** A seeded PRNG, so the property test is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('AskMessageStreamService', () => {
  // ==========================================================================
  // The happy path
  // ==========================================================================

  it('streams pending → steps → text → done, in that order', async () => {
    const answer = 'Acme renewed in March [^ev1]. The contract runs two years.';
    const { prisma } = scripted(
      respondRows(answer, [10, 30], 2, {
        status: 'complete',
        citations: [CITATION],
        finishReason: 'stop',
        promptTokens: 812,
        completionTokens: 40,
      }),
    );

    const emitted = frames(await collect(service(prisma)));

    expect(emitted.map((m) => m.type)).toEqual(['step', 'step', 'delta', 'delta', 'delta', 'done']);
    expect(deltas(emitted).join('')).toBe(answer);
    expect(emitted[0].data).toEqual({
      index: 0,
      name: 'search',
      summary: 'Step 0',
      resultCount: 1,
      error: null,
      offset: 0,
    });
    expect(emitted.at(-1)).toEqual({
      type: 'done',
      id: String(answer.length),
      data: {
        status: 'succeeded',
        offset: answer.length,
        citations: [CITATION],
        finishReason: 'stop',
        promptTokens: 812,
        completionTokens: 40,
      },
    });
  });

  it('gives text frames monotonically increasing offset ids; steps never advance them', async () => {
    const answer = 'abcdefghij';
    const steps = [tool(0), tool(1)];
    const { prisma } = scripted([
      row({ toolCalls: [steps[0]] }),
      row({ toolCalls: [steps[0]], content: 'abc' }),
      row({ toolCalls: steps, content: 'abc' }),
      row({ toolCalls: steps, content: 'abcdef' }),
      row({ status: 'complete', toolCalls: steps, content: answer }),
    ]);

    const emitted = frames(await collect(service(prisma)));

    expect(emitted.map((m) => `${m.type}:${m.id}`)).toEqual([
      'step:0',
      'delta:3',
      'step:3',
      'delta:6',
      'delta:10',
      'done:10',
    ]);
    for (const m of emitted) expect(Number(m.id)).toBe((m.data as { offset: number }).offset);
  });

  it('flushes the tail and any last step in the same poll as done', async () => {
    const { prisma } = scripted([
      row({ content: 'partial' }),
      row({ status: 'complete', content: 'partial and the rest', toolCalls: [tool(0)] }),
    ]);

    const emitted = frames(await collect(service(prisma)));

    expect(emitted.map((m) => m.type)).toEqual(['delta', 'step', 'delta', 'done']);
    expect(deltas(emitted)).toEqual(['partial', ' and the rest']);
  });

  it('reads a complete row with no finish reason as stop, and malformed JSON as empty', async () => {
    const { prisma } = scripted([
      row({ status: 'complete', content: 'ok', citations: [{ nope: true }, CITATION], toolCalls: 'garbage' }),
    ]);

    const done = frames(await collect(service(prisma))).at(-1);

    expect(done?.data).toMatchObject({ finishReason: 'stop', citations: [CITATION], promptTokens: null });
  });

  it('carries a capped finish reason through', async () => {
    const { prisma } = scripted([row({ status: 'complete', content: 'best answer', finishReason: 'step_cap' })]);

    expect(frames(await collect(service(prisma))).at(-1)?.data).toMatchObject({ finishReason: 'step_cap' });
  });

  // ==========================================================================
  // Pending
  // ==========================================================================

  it('sends nothing but comments while the turn is pending', async () => {
    let clock = 0;
    const { prisma } = scripted([row({ status: 'pending' })]);

    const messages = await collect(
      service(prisma, { heartbeatIntervalMs: 1, durationCapMs: 25, now: () => (clock += 5) }),
    );

    expect(comments(messages)[0]).toBe('connected');
    expect(comments(messages).filter((c) => c === 'heartbeat').length).toBeGreaterThan(0);
    expect(frames(messages).map((m) => m.type)).toEqual(['error']);
  });

  it('announces a rerun’s steps after a rate-limit reset back to pending', async () => {
    // #378: rate-limited before any answer text → `pending`, `tool_calls: []`,
    // re-thrown; the queue reruns it later and records fresh steps from 0.
    const { prisma } = scripted([
      row({ toolCalls: [tool(0, 'First try')] }),
      row({ status: 'pending', toolCalls: [] }),
      row({ status: 'streaming', toolCalls: [] }),
      row({ toolCalls: [tool(0, 'Second try')] }),
      row({ status: 'complete', toolCalls: [tool(0, 'Second try')], content: 'Found it.' }),
    ]);

    const emitted = frames(await collect(service(prisma)));
    const summaries = emitted.filter((m) => m.type === 'step').map((m) => (m.data as { summary: string }).summary);

    expect(summaries).toEqual(['First try', 'Second try']);
    expect(deltas(emitted).join('')).toBe('Found it.');
  });

  // ==========================================================================
  // Attaching late, and resuming
  // ==========================================================================

  it('hands a late attach every step, the whole answer and done in one round trip', async () => {
    const { prisma, calls } = scripted([
      row({ status: 'complete', content: 'already answered', toolCalls: [tool(1), tool(0)] }),
    ]);

    const emitted = frames(await collect(service(prisma)));

    expect(calls()).toBe(1);
    expect(emitted.map((m) => m.type)).toEqual(['step', 'step', 'delta', 'done']);
    expect(stepIndexes(emitted)).toEqual([0, 1]);
  });

  it('re-sends every recorded step on a resume, before the missing text', async () => {
    const answer = 'first half. second half.';
    const seen = 'first half.'.length;
    const { prisma } = scripted([row({ status: 'complete', content: answer, toolCalls: [tool(0), tool(1)] })]);

    const emitted = frames(await collect(service(prisma), seen));

    expect(emitted.map((m) => m.type)).toEqual(['step', 'step', 'delta', 'done']);
    // A step sent on resume sits at the resumed offset — never 0, never ahead.
    expect(emitted[0].data).toMatchObject({ offset: seen });
    expect(deltas(emitted).join('')).toBe(answer.slice(seen));
  });

  it('replays no text to a caught-up client, and clamps an offset past the end', async () => {
    const answer = 'every byte already delivered';

    const caughtUp = scripted([row({ status: 'complete', content: answer })]);
    expect(frames(await collect(service(caughtUp.prisma), answer.length)).map((m) => m.type)).toEqual(['done']);

    const ahead = scripted([row({ content: 'short' }), row({ status: 'complete', content: 'short and more' })]);
    const emitted = frames(await collect(service(ahead.prisma), 10_000));
    expect(deltas(emitted)).toEqual([' and more']);
    expect(emitted.at(-1)?.data).toMatchObject({ offset: 'short and more'.length });
  });

  it('property: from any resume offset, the deltas reproduce content exactly', async () => {
    const random = mulberry32(379);
    const alphabet = 'abc def, ghí ☃ [^ev1] \n'; // includes a BMP multi-byte char

    for (let trial = 0; trial < 40; trial += 1) {
      const length = 1 + Math.floor(random() * 200);
      const answer = Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
      const splits = [...new Set(Array.from({ length: Math.floor(random() * 8) }, () => Math.floor(random() * length)))].sort(
        (a, b) => a - b,
      );
      const from = Math.floor(random() * (length + 1));

      // A client can only hold offset `from` once `content` has reached it, and
      // `content` is append-only — so the reconnect sees the turn from the first
      // state at least that long. (Earlier, shorter states would trip the
      // cursor's deliberate clamp, which is `note-stream.spec.ts`'s business.)
      const history = respondRows(answer, splits, Math.floor(random() * 4), { status: 'complete' });
      const reconnectAt = history.findIndex((r) => r.content.length >= from);
      const { prisma } = scripted(history.slice(reconnectAt));
      const emitted = await collect(service(prisma), from);

      expect(deltas(emitted).join('')).toBe(answer.slice(from));
      expect(frames(emitted).at(-1)?.data).toMatchObject({ status: 'succeeded', offset: answer.length });
    }
  });

  // ==========================================================================
  // Termination
  // ==========================================================================

  it('flushes remaining text, then error with the stored class', async () => {
    const { prisma } = scripted([
      row({ content: 'half an' }),
      row({ status: 'failed', content: 'half an answer', errorClass: 'rate_limit' }),
    ]);

    const emitted = frames(await collect(service(prisma)));

    expect(emitted.map((m) => m.type)).toEqual(['delta', 'delta', 'error']);
    expect(emitted.at(-1)).toEqual({
      type: 'error',
      id: String('half an answer'.length),
      data: { status: 'failed', offset: 'half an answer'.length, errorClass: 'rate_limit', reason: null },
    });
  });

  it.each(['auth', 'refusal', 'rate_limit', 'budget', 'timeout', 'other'])(
    'passes the stored class %s through',
    async (errorClass) => {
      const { prisma } = scripted([row({ status: 'failed', errorClass })]);
      expect(frames(await collect(service(prisma))).at(-1)?.data).toMatchObject({ errorClass, reason: null });
    },
  );

  it('maps a failed row with no or an unknown class to other', async () => {
    const none = scripted([row({ status: 'failed', errorClass: null })]);
    const unknown = scripted([row({ status: 'failed', errorClass: 'meteor' })]);

    expect(frames(await collect(service(none.prisma))).at(-1)?.data).toMatchObject({ errorClass: 'other' });
    expect(frames(await collect(service(unknown.prisma))).at(-1)?.data).toMatchObject({ errorClass: 'other' });
  });

  it('ends with error gone when the row disappears (conversation deleted)', async () => {
    const { prisma, calls } = scripted([row({ content: 'some text' }), null]);

    const emitted = frames(await collect(service(prisma)));

    expect(emitted.map((m) => m.type)).toEqual(['delta', 'error']);
    expect(emitted[1].data).toEqual({ status: 'failed', offset: 9, errorClass: 'gone', reason: 'message_gone' });
    expect(calls()).toBe(2);
  });

  it('gives up on the duration cap with timeout / stream_duration_cap, and stops polling', async () => {
    let clock = 0;
    const findUnique = jest.fn(async () => {
      clock += 400;
      return row({ content: 'x'.repeat(clock / 400) });
    });
    const prisma = { askMessage: { findUnique } } as unknown as PrismaService;

    const emitted = frames(await collect(service(prisma, { durationCapMs: 1000, now: () => clock })));

    expect(emitted.at(-1)?.data).toEqual({
      status: 'failed',
      offset: 3,
      errorClass: 'timeout',
      reason: 'stream_duration_cap',
    });

    const after = findUnique.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(findUnique.mock.calls.length).toBe(after);
  });

  it('stops polling the moment the client disconnects, and writes nothing', async () => {
    const { prisma, calls } = scripted([row({ content: 'still going' })]);

    const subscription = service(prisma).stream('msg-1').subscribe();
    await new Promise((resolve) => setTimeout(resolve, 10));
    subscription.unsubscribe();

    const atDisconnect = calls();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls()).toBe(atDisconnect);
    expect(atDisconnect).toBeGreaterThan(0);
    // The stand-in has no write method at all: a write would have thrown.
    expect(Object.keys((prisma as unknown as { askMessage: object }).askMessage)).toEqual(['findUnique']);
  });

  it('survives a transient read failure', async () => {
    let call = 0;
    const findUnique = jest.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('connection terminated unexpectedly');
      return row({ status: 'complete', content: 'fine all along' });
    });
    const prisma = { askMessage: { findUnique } } as unknown as PrismaService;

    expect(frames(await collect(service(prisma))).map((m) => m.type)).toEqual(['delta', 'done']);
  });

  it('reads one row by primary key with the narrow select', async () => {
    const { prisma, findUnique } = scripted([row({ status: 'complete' })]);

    await collect(service(prisma), 0, 'the-id');

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'the-id' },
      select: {
        status: true,
        content: true,
        toolCalls: true,
        citations: true,
        promptTokens: true,
        completionTokens: true,
        errorClass: true,
        finishReason: true,
      },
    });
  });

  // ==========================================================================
  // Defaults
  // ==========================================================================

  it('derives its default cap from ask.respond’s five-minute runtime plus the notes margin', () => {
    expect(ASK_RESPOND_STREAM_RUNTIME_MS).toBe(5 * 60_000);
    expect(DEFAULT_ASK_STREAM_DURATION_CAP_MS).toBe(ASK_RESPOND_STREAM_RUNTIME_MS + STREAM_DURATION_CAP_MARGIN_MS);
  });

  it('ships the note stream’s poll and heartbeat cadence when nothing is overridden', () => {
    const svc = new AskMessageStreamService({} as PrismaService);
    const tuning = (svc as unknown as { tuning: AskStreamTuning }).tuning;

    expect(tuning.pollIntervalMs).toBe(250);
    expect(tuning.heartbeatIntervalMs).toBe(25_000);
    expect(tuning.durationCapMs).toBe(6 * 60_000);
  });
});

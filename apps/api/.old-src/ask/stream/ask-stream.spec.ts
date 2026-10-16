import { ASK_ERROR_CLASSES, type AskToolCall } from '../dto/ask.dto';
import {
  NOTE_STREAM_DELTA_EVENT,
  NOTE_STREAM_DONE_EVENT,
  NOTE_STREAM_ERROR_EVENT,
} from '../../notes/generation/note-stream';
import {
  ASK_STREAM_CAP_REASON,
  ASK_STREAM_DELTA_EVENT,
  ASK_STREAM_DONE_EVENT,
  ASK_STREAM_ERROR_CLASSES,
  ASK_STREAM_ERROR_EVENT,
  ASK_STREAM_STEP_EVENT,
  StepCursor,
  toAskDoneFrame,
  toAskErrorFrame,
  toAskFinishReason,
  toAskStepFrame,
  toAskStreamErrorClass,
  toStepData,
} from './ask-stream';

// =============================================================================
// The Ask stream's pure contract (issue #379, epic #348)
// =============================================================================
//
// The text arithmetic (`NoteStreamCursor`) is the note stream's and is pinned
// by `note-stream.spec.ts`; this file pins what Ask ADDS — the event names the
// web client (#380) compiles in, the `step` frame, the done/error payloads and
// the `StepCursor` that decides which steps a connection has announced.
// =============================================================================

const call = (index: number, overrides: Partial<AskToolCall> = {}): AskToolCall => ({
  index,
  name: 'search',
  arguments: { query: 'Acme' },
  summary: `Step ${index}`,
  resultCount: 2,
  durationMs: 40,
  error: null,
  ...overrides,
});

describe('ask stream event names', () => {
  it('reuses the note stream’s delta/done/error values and adds step', () => {
    // `apps/web/src/services/askStream.ts` compiles these exact strings in; a
    // mismatch fails silently, so they are pinned as literals too.
    expect(ASK_STREAM_DELTA_EVENT).toBe(NOTE_STREAM_DELTA_EVENT);
    expect(ASK_STREAM_DONE_EVENT).toBe(NOTE_STREAM_DONE_EVENT);
    expect(ASK_STREAM_ERROR_EVENT).toBe(NOTE_STREAM_ERROR_EVENT);
    expect([ASK_STREAM_DELTA_EVENT, ASK_STREAM_STEP_EVENT, ASK_STREAM_DONE_EVENT, ASK_STREAM_ERROR_EVENT]).toEqual([
      'delta',
      'step',
      'done',
      'error',
    ]);
  });
});

describe('error classes', () => {
  it('is #376’s stored classes plus the wire-only gone', () => {
    expect(ASK_STREAM_ERROR_CLASSES).toEqual([...ASK_ERROR_CLASSES, 'gone']);
    expect(ASK_STREAM_ERROR_CLASSES).toEqual(['auth', 'refusal', 'rate_limit', 'budget', 'timeout', 'other', 'gone']);
  });

  it('passes every stored class through unchanged', () => {
    for (const stored of ASK_ERROR_CLASSES) expect(toAskStreamErrorClass(stored)).toBe(stored);
  });

  it('is total: null, unknown and the wire-only gone all read as other', () => {
    for (const stored of [null, undefined, '', 'meteor', 'gone']) {
      expect(toAskStreamErrorClass(stored)).toBe('other');
    }
  });
});

describe('toAskFinishReason', () => {
  it('passes each cap through and reads anything else as stop', () => {
    expect(toAskFinishReason('step_cap')).toBe('step_cap');
    expect(toAskFinishReason('token_cap')).toBe('token_cap');
    expect(toAskFinishReason('time_cap')).toBe('time_cap');
    expect(toAskFinishReason('stop')).toBe('stop');
    expect(toAskFinishReason(null)).toBe('stop');
    expect(toAskFinishReason('whatever')).toBe('stop');
  });
});

describe('frame builders', () => {
  it('renders a step at the current offset, without arguments or duration', () => {
    const frame = toAskStepFrame(toStepData(call(3, { error: 'Unknown handle' }), 17));

    expect(frame.type).toBe('step');
    expect(frame.id).toBe('17');
    expect(frame.data).toEqual({
      index: 3,
      name: 'search',
      summary: 'Step 3',
      resultCount: 2,
      error: 'Unknown handle',
      offset: 17,
    });
  });

  it('renders done with citations, finish reason and tokens', () => {
    const frame = toAskDoneFrame({
      status: 'succeeded',
      offset: 40,
      citations: [],
      finishReason: 'step_cap',
      promptTokens: 900,
      completionTokens: 50,
    });

    expect(frame).toEqual({
      type: 'done',
      id: '40',
      data: {
        status: 'succeeded',
        offset: 40,
        citations: [],
        finishReason: 'step_cap',
        promptTokens: 900,
        completionTokens: 50,
      },
    });
  });

  it('renders error with its class and reason', () => {
    const frame = toAskErrorFrame({ status: 'failed', offset: 5, errorClass: 'timeout', reason: ASK_STREAM_CAP_REASON });

    expect(frame).toEqual({
      type: 'error',
      id: '5',
      data: { status: 'failed', offset: 5, errorClass: 'timeout', reason: 'stream_duration_cap' },
    });
  });
});

describe('StepCursor', () => {
  it('announces every recorded step once, in index order, on the first call', () => {
    const cursor = new StepCursor();

    expect(cursor.next([call(2), call(0), call(1)]).map((c) => c.index)).toEqual([0, 1, 2]);
    expect(cursor.next([call(0), call(1), call(2)])).toEqual([]);
    expect(cursor.size).toBe(3);
  });

  it('then yields only what was appended since', () => {
    const cursor = new StepCursor();

    cursor.next([call(0)]);

    expect(cursor.next([call(0), call(1)]).map((c) => c.index)).toEqual([1]);
    expect(cursor.next([call(0), call(1), call(2), call(3)]).map((c) => c.index)).toEqual([2, 3]);
    expect(cursor.next([call(0), call(1), call(2), call(3)])).toEqual([]);
  });

  it('a new cursor (a reconnect) re-announces everything', () => {
    const recorded = [call(0), call(1)];
    new StepCursor().next(recorded);

    expect(new StepCursor().next(recorded).map((c) => c.index)).toEqual([0, 1]);
  });

  it('treats a duplicated index within one array as one step', () => {
    expect(new StepCursor().next([call(0), call(0, { summary: 'again' })])).toHaveLength(1);
  });

  it('forgets indexes that vanished, so a rerun after a rate-limit reset is announced', () => {
    // #378 resets a turn rate-limited before any answer text to
    // `tool_calls: []` and records fresh steps from index 0 when it reruns.
    const cursor = new StepCursor();

    cursor.next([call(0), call(1)]);
    expect(cursor.next([])).toEqual([]);
    expect(cursor.size).toBe(0);

    const rerun = cursor.next([call(0, { summary: 'Rerun step' })]);
    expect(rerun.map((c) => c.summary)).toEqual(['Rerun step']);
  });
});

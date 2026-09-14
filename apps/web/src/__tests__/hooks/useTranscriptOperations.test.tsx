import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('../../services/transcriptEditing', async () => {
  const actual = await vi.importActual<typeof import('../../services/transcriptEditing')>(
    '../../services/transcriptEditing',
  );
  return {
    ...actual,
    applyOperations: vi.fn(),
    restoreTranscriptVersion: vi.fn(),
  };
});

vi.mock('../../services/transcripts', () => ({
  getTranscript: vi.fn(),
  getTranscriptSegments: vi.fn(),
}));

import { useTranscriptOperations } from '../../hooks/useTranscriptOperations';
import { ApiError } from '../../services/api';
import {
  applyOperations,
  restoreTranscriptVersion,
} from '../../services/transcriptEditing';
import type { OperationsResult } from '../../services/transcriptEditing';
import { getTranscript, getTranscriptSegments } from '../../services/transcripts';
import type { TranscriptSegment, TranscriptSpeaker } from '../../services/transcripts';

/**
 * The correction queue, over its real timers and its real drain loop with the
 * SERVICE mocked. Mocking the hook's own internals would leave the thing it is
 * made of — batching, revs, retry, conflict resolution — asserted by nothing.
 *
 * `debounceMs: 20` throughout: the production 1.5 s is a product decision, and
 * a suite that waited it out would spend a minute proving arithmetic.
 */

const mockApply = vi.mocked(applyOperations);
const mockRestore = vi.mocked(restoreTranscriptVersion);
const mockGetTranscript = vi.mocked(getTranscript);
const mockGetSegments = vi.mocked(getTranscriptSegments);

const SPEAKERS: TranscriptSpeaker[] = [
  { id: 'sp1', label: 'A', displayName: 'Ana', colorIndex: 0, rev: 3 },
  { id: 'sp2', label: 'B', displayName: 'Ben', colorIndex: 1, rev: 1 },
];

function segment(index: number, overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: `s${index}`,
    speakerId: index % 2 === 0 ? 'sp1' : 'sp2',
    startMs: index * 1000,
    endMs: index * 1000 + 900,
    ordinal: (index + 1) * 1000,
    text: `Line ${index} words here`,
    wordsAlignment: 'exact',
    confidence: 0.9,
    origin: 'ai',
    rev: index + 1,
    editedAt: null,
    ...overrides,
  };
}

const SEGMENTS = [segment(0), segment(1), segment(2)];

function result(overrides: Partial<OperationsResult> = {}): OperationsResult {
  return {
    version: 8,
    summary: 'Edited 1 segment',
    idempotentReplay: false,
    speakers: SPEAKERS,
    segments: SEGMENTS,
    merges: [],
    ...overrides,
  };
}

function setup(enabled = true) {
  return renderHook(() =>
    useTranscriptOperations({
      transcriptId: 't1',
      speakers: SPEAKERS,
      segments: SEGMENTS,
      version: 7,
      enabled,
      debounceMs: 20,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApply.mockResolvedValue(result());
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

afterEach(() => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('useTranscriptOperations — the ops it sends', () => {
  it('sends segment.update_text with the segment’s own rev', async () => {
    const { result: hook } = setup();

    act(() => hook.current.updateText('s1', 'Corrected line'));
    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));

    const [id, body] = mockApply.mock.calls[0];
    expect(id).toBe('t1');
    expect(body.baseVersion).toBe(7);
    expect(body.ops).toEqual([
      { op: 'segment.update_text', segmentId: 's1', rev: 2, text: 'Corrected line' },
    ]);
  });

  it('turns a BURST of edits into exactly one batch', async () => {
    const { result: hook } = setup();

    // Five keystrokes on one line and one on another — six calls, one save.
    act(() => {
      hook.current.updateText('s0', 'a');
      hook.current.updateText('s0', 'ab');
      hook.current.updateText('s0', 'abc');
      hook.current.updateText('s0', 'abcd');
      hook.current.updateText('s1', 'other');
    });

    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));
    const body = mockApply.mock.calls[0][1];
    expect(body.ops).toHaveLength(2);
    // Coalesced: the intermediate states are not history.
    expect(body.ops[0]).toMatchObject({ segmentId: 's0', text: 'abcd' });
    expect(body.ops[1]).toMatchObject({ segmentId: 's1', text: 'other' });
  });

  it('applies the edit optimistically, before the send resolves', async () => {
    let release: ((value: OperationsResult) => void) | undefined;
    mockApply.mockReturnValue(
      new Promise<OperationsResult>((resolve) => {
        release = resolve;
      }),
    );
    const { result: hook } = setup();

    act(() => hook.current.updateText('s1', 'Instant'));

    expect(hook.current.segments.find((s) => s.id === 's1')?.text).toBe('Instant');
    await act(async () => release?.(result()));
  });

  it('sends segment.set_speaker immediately, without waiting for the debounce', async () => {
    const { result: hook } = setup();

    await act(async () => {
      await hook.current.setSpeaker('s0', 'sp2');
    });

    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply.mock.calls[0][1].ops).toEqual([
      { op: 'segment.set_speaker', segmentId: 's0', rev: 1, speakerId: 'sp2' },
    ]);
  });

  it('sends segment.join with LENGTH-2 arrays of ids and revs, in reading order', async () => {
    const { result: hook } = setup();

    await act(async () => {
      await hook.current.joinWithNext('s1');
    });

    expect(mockApply.mock.calls[0][1].ops).toEqual([
      { op: 'segment.join', segmentIds: ['s1', 's2'], revs: [2, 3] },
    ]);
  });

  it('refuses to join the LAST segment — there is nothing after it', async () => {
    const { result: hook } = setup();

    await act(async () => {
      await hook.current.joinWithNext('s2');
    });

    expect(mockApply).not.toHaveBeenCalled();
  });

  it('sends segment.split as atCharOffset and never both split points', async () => {
    const { result: hook } = setup();

    await act(async () => {
      await hook.current.splitSegment('s0', 7, 'sp2');
    });

    const op = mockApply.mock.calls[0][1].ops[0] as Record<string, unknown>;
    expect(op).toMatchObject({
      op: 'segment.split',
      segmentId: 's0',
      rev: 1,
      atCharOffset: 7,
      newSpeakerId: 'sp2',
    });
    expect(op.atWordIndex).toBeUndefined();
  });

  it('refuses a split at either end — an empty half is not a split', async () => {
    const { result: hook } = setup();

    await act(async () => {
      await hook.current.splitSegment('s0', 0);
      await hook.current.splitSegment('s0', SEGMENTS[0].text.length);
    });

    expect(mockApply).not.toHaveBeenCalled();
  });

  it('sends speaker.rename with the speaker’s own rev', async () => {
    const { result: hook } = setup();

    await act(async () => {
      await hook.current.renameSpeaker('sp1', '  Ana Ruiz  ');
    });

    expect(mockApply.mock.calls[0][1].ops).toEqual([
      { op: 'speaker.rename', speakerId: 'sp1', rev: 3, displayName: 'Ana Ruiz' },
    ]);
  });

  it('sends speaker.merge with keepName spelled out rather than defaulted', async () => {
    const { result: hook } = setup();

    await act(async () => {
      await hook.current.mergeSpeakers(['sp2'], 'sp1', false);
    });

    expect(mockApply.mock.calls[0][1].ops).toEqual([
      { op: 'speaker.merge', sourceIds: ['sp2'], targetId: 'sp1', keepName: false },
    ]);
  });

  it('sends ONE transcript.find_replace for Replace all', async () => {
    const { result: hook } = setup();

    await act(async () => {
      await hook.current.replaceAll({
        find: 'Teh',
        replace: 'The',
        matchCase: true,
        wholeWord: true,
        speakerId: 'sp1',
      });
    });

    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply.mock.calls[0][1].ops).toEqual([
      {
        op: 'transcript.find_replace',
        find: 'Teh',
        replace: 'The',
        matchCase: true,
        wholeWord: true,
        speakerId: 'sp1',
      },
    ]);
  });

  it('flushes pending text BEFORE a structural op, so its rev is the fresh one', async () => {
    mockApply
      .mockResolvedValueOnce(
        result({
          version: 8,
          segments: SEGMENTS.map((s) => (s.id === 's0' ? { ...s, rev: 99 } : s)),
        }),
      )
      .mockResolvedValueOnce(result({ version: 9 }));
    const { result: hook } = setup();

    act(() => hook.current.updateText('s0', 'typed'));
    await act(async () => {
      await hook.current.deleteSegment('s0');
    });

    expect(mockApply).toHaveBeenCalledTimes(2);
    // Two batches, and the delete carries rev 99 — the one the first batch's
    // response delivered, not the stale 1 it would have been built from.
    expect(mockApply.mock.calls[0][1].ops[0]).toMatchObject({ op: 'segment.update_text' });
    expect(mockApply.mock.calls[1][1].ops[0]).toEqual({
      op: 'segment.delete',
      segmentId: 's0',
      rev: 99,
    });
  });

  it('is inert for a viewer', async () => {
    const { result: hook } = setup(false);

    act(() => hook.current.updateText('s0', 'nope'));
    await act(async () => {
      await hook.current.setSpeaker('s0', 'sp2');
      await hook.current.deleteSegment('s0');
    });

    expect(mockApply).not.toHaveBeenCalled();
  });
});

describe('useTranscriptOperations — idempotency and retry', () => {
  it('gives each batch a distinct clientBatchId', async () => {
    const { result: hook } = setup();

    await act(async () => {
      await hook.current.setSpeaker('s0', 'sp2');
    });
    await act(async () => {
      await hook.current.renameSpeaker('sp2', 'Ben Olsen');
    });

    const first = mockApply.mock.calls[0][1].clientBatchId;
    const second = mockApply.mock.calls[1][1].clientBatchId;
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(8);
  });

  it('retries a network failure with the SAME clientBatchId', async () => {
    mockApply
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(result());
    const { result: hook } = setup();

    act(() => hook.current.updateText('s1', 'again'));

    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    // The whole point of the key: a save that landed but whose response was
    // lost must not become a second version.
    expect(mockApply.mock.calls[0][1].clientBatchId).toBe(
      mockApply.mock.calls[1][1].clientBatchId,
    );
    await waitFor(() => expect(hook.current.saveState).toBe('saved'));
  });

  it('does NOT retry a 403 — it reports it, naming the missing access', async () => {
    mockApply.mockRejectedValue(new ApiError('Forbidden', 403));
    const { result: hook } = setup();

    act(() => hook.current.updateText('s1', 'nope'));

    await waitFor(() => expect(hook.current.error).toMatch(/not change it/i));
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(hook.current.saveState).toBe('error');
  });
});

describe('useTranscriptOperations — conflicts', () => {
  const conflict = new ApiError('Conflict', 409, 'CONFLICT', {
    currentVersion: 9,
    conflicts: [{ entity: 'segment', id: 's1', current: 5 }],
  });

  beforeEach(() => {
    mockGetTranscript.mockResolvedValue({
      status: 'ok',
      data: { speakers: SPEAKERS } as never,
      etag: null,
    });
    mockGetSegments.mockResolvedValue({
      status: 'ok',
      data: {
        currentVersion: 9,
        segments: SEGMENTS.map((s) =>
          s.id === 's1' ? { ...s, rev: 5, text: 'Their version' } : s,
        ),
      },
      etag: null,
    });
  });

  it('keeps the user’s text and offers both choices', async () => {
    mockApply.mockRejectedValueOnce(conflict);
    const { result: hook } = setup();

    act(() => hook.current.updateText('s1', 'My version'));

    await waitFor(() => expect(hook.current.conflicts).toHaveLength(1));
    expect(hook.current.conflicts[0]).toMatchObject({
      entity: 'segment',
      id: 's1',
      mine: 'My version',
      theirs: 'Their version',
      currentRev: 5,
    });
    // The refetch happened AND the local text survived it.
    expect(hook.current.segments.find((s) => s.id === 's1')?.text).toBe('My version');
  });

  it('"keep mine" re-sends against the rev that won', async () => {
    mockApply.mockRejectedValueOnce(conflict).mockResolvedValue(result({ version: 10 }));
    const { result: hook } = setup();

    act(() => hook.current.updateText('s1', 'My version'));
    await waitFor(() => expect(hook.current.conflicts).toHaveLength(1));

    await act(async () => {
      hook.current.resolveConflict('s1', 'mine');
    });

    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(2));
    expect(mockApply.mock.calls[1][1].ops).toEqual([
      { op: 'segment.update_text', segmentId: 's1', rev: 5, text: 'My version' },
    ]);
    expect(hook.current.conflicts).toHaveLength(0);
  });

  it('"use theirs" sends nothing and adopts the server text', async () => {
    mockApply.mockRejectedValueOnce(conflict);
    const { result: hook } = setup();

    act(() => hook.current.updateText('s1', 'My version'));
    await waitFor(() => expect(hook.current.conflicts).toHaveLength(1));
    mockApply.mockClear();

    act(() => hook.current.resolveConflict('s1', 'theirs'));

    expect(hook.current.segments.find((s) => s.id === 's1')?.text).toBe('Their version');
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('treats a 409 whose details are not a conflict as an error, not a card', async () => {
    mockApply.mockRejectedValue(new ApiError('Already current', 409));
    const { result: hook } = setup();

    act(() => hook.current.updateText('s1', 'x'));

    await waitFor(() => expect(hook.current.saveState).toBe('error'));
    expect(hook.current.conflicts).toHaveLength(0);
  });
});

describe('useTranscriptOperations — offline and the unload guard', () => {
  it('holds the batch while offline and flushes on reconnect', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const { result: hook } = setup();

    act(() => hook.current.updateText('s1', 'written on a train'));
    await waitFor(() => expect(hook.current.saveState).toBe('offline'));
    expect(mockApply).not.toHaveBeenCalled();
    expect(hook.current.pendingCount).toBeGreaterThan(0);

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(mockApply).toHaveBeenCalledTimes(1));
    expect(mockApply.mock.calls[0][1].ops[0]).toMatchObject({ text: 'written on a train' });
  });

  it('guards the unload while anything is unsent, and stops once it is saved', async () => {
    let release: ((value: OperationsResult) => void) | undefined;
    mockApply.mockReturnValue(
      new Promise<OperationsResult>((resolve) => {
        release = resolve;
      }),
    );
    const { result: hook } = setup();

    act(() => hook.current.updateText('s1', 'unsaved'));
    await waitFor(() => expect(hook.current.pendingCount).toBeGreaterThan(0));

    const guarded = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(guarded);
    expect(guarded.defaultPrevented).toBe(true);

    await act(async () => {
      release?.(result());
    });
    await waitFor(() => expect(hook.current.pendingCount).toBe(0));

    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });
});

describe('useTranscriptOperations — undo a merge', () => {
  const merged = result({
    version: 8,
    summary: 'Merged Ben into Ana',
    merges: [
      {
        targetId: 'sp1',
        sources: [
          {
            speakerId: 'sp2',
            label: 'B',
            displayName: 'Ben',
            colorIndex: 1,
            segmentIds: ['s1'],
          },
        ],
      },
    ],
  });

  it('offers an undo after a merge, and restores version − 1 when nothing is newer', async () => {
    mockApply.mockResolvedValue(merged);
    mockRestore.mockResolvedValue(result({ version: 9 }));
    const { result: hook } = setup();

    await act(async () => {
      await hook.current.mergeSpeakers(['sp2'], 'sp1', true);
    });
    await waitFor(() => expect(hook.current.undoableMerge).not.toBeNull());

    await act(async () => {
      await hook.current.undoMerge();
    });

    expect(mockRestore).toHaveBeenCalledWith('t1', 7, 8);
  });

  it('sends inverse ops instead when something newer has landed', async () => {
    mockApply.mockResolvedValueOnce(merged);
    const { result: hook } = setup();

    await act(async () => {
      await hook.current.mergeSpeakers(['sp2'], 'sp1', true);
    });
    await waitFor(() => expect(hook.current.undoableMerge).not.toBeNull());

    // Somebody else saves; the merge is no longer the newest version, so
    // restoring would discard their work.
    const recreated: TranscriptSpeaker = {
      id: 'sp9',
      label: null,
      displayName: 'Ben',
      colorIndex: 1,
      rev: 1,
    };
    mockApply
      .mockResolvedValueOnce(result({ version: 11 }))
      .mockResolvedValueOnce(
        result({ version: 12, speakers: [...SPEAKERS, recreated] }),
      )
      .mockResolvedValueOnce(result({ version: 13 }));
    await act(async () => {
      await hook.current.renameSpeaker('sp1', 'Ana Ruiz');
    });

    mockApply.mockClear();
    mockApply
      .mockResolvedValueOnce(result({ version: 14, speakers: [...SPEAKERS, recreated] }))
      .mockResolvedValue(result({ version: 15 }));

    await act(async () => {
      await hook.current.undoMerge();
    });

    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockApply.mock.calls[0][1].ops).toEqual([
      { op: 'speaker.create', displayName: 'Ben' },
    ]);
    expect(mockApply.mock.calls[1][1].ops).toEqual([
      { op: 'segment.set_speaker', segmentId: 's1', rev: 2, speakerId: 'sp9' },
    ]);
  });
});

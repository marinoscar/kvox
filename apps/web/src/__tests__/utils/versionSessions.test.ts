import { describe, it, expect } from 'vitest';

import {
  authorLabel,
  groupVersionsIntoSessions,
  sessionSummary,
} from '../../utils/versionSessions';
import type { TranscriptVersionSummary } from '../../services/transcriptEditing';

function version(
  number: number,
  overrides: Partial<TranscriptVersionSummary> = {},
): TranscriptVersionSummary {
  return {
    version: number,
    kind: 'edit',
    summary: 'Edited 1 segment',
    author: { id: 'u1', name: 'Ana Ruiz', email: 'ana@example.com' },
    restoredFromVersion: null,
    hasSnapshot: false,
    opCount: 1,
    createdAt: '2026-09-14T10:00:00.000Z',
    ...overrides,
  };
}

describe('groupVersionsIntoSessions', () => {
  it('folds consecutive saves by one author on one day into one session', () => {
    const sessions = groupVersionsIntoSessions([
      version(5, { createdAt: '2026-09-14T16:00:00.000Z' }),
      version(4, { createdAt: '2026-09-14T15:59:00.000Z' }),
      version(3, { createdAt: '2026-09-14T09:00:00.000Z' }),
    ]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].versions.map((v) => v.version)).toEqual([5, 4, 3]);
  });

  it('splits on a different author', () => {
    const sessions = groupVersionsIntoSessions([
      version(5),
      version(4, { author: { id: 'u2', name: 'Ben Olsen', email: null } }),
      version(3),
    ]);

    expect(sessions).toHaveLength(3);
  });

  it('splits on a different local day', () => {
    const sessions = groupVersionsIntoSessions([
      version(5, { createdAt: '2026-09-14T10:00:00.000Z' }),
      version(4, { createdAt: '2026-09-13T10:00:00.000Z' }),
    ]);

    expect(sessions).toHaveLength(2);
  });

  it('never folds version 1 into a session — it is the one row that is not an edit', () => {
    const sessions = groupVersionsIntoSessions([
      version(2),
      version(1, { kind: 'ai_original', author: null, summary: null }),
    ]);

    expect(sessions).toHaveLength(2);
    expect(sessions[1].isAiOriginal).toBe(true);
    expect(sessions[1].authorName).toBeNull();
  });

  it('never folds a restore into a session', () => {
    const sessions = groupVersionsIntoSessions([
      version(7),
      version(6, { kind: 'restore', restoredFromVersion: 3, summary: null }),
      version(5),
    ]);

    expect(sessions.map((session) => session.isRestore)).toEqual([false, true, false]);
  });
});

describe('authorLabel', () => {
  it('says the AI did it when the author is null, which is the schema’s convention', () => {
    expect(authorLabel(version(1, { author: null }))).toBe('Transcribed automatically');
  });

  it('falls back to the email when there is no display name', () => {
    expect(
      authorLabel(version(2, { author: { id: 'u1', name: null, email: 'a@b.c' } })),
    ).toBe('a@b.c');
  });
});

describe('sessionSummary', () => {
  it('prefers the server’s own summaries and dedupes them', () => {
    const [session] = groupVersionsIntoSessions([
      version(4, { summary: 'Merged Ben into Ana' }),
      version(3, { summary: 'Edited 1 segment' }),
      version(2, { summary: 'Edited 1 segment' }),
    ]);

    expect(sessionSummary(session)).toBe('Merged Ben into Ana · Edited 1 segment');
  });

  it('counts instead when no version carries a summary', () => {
    const [session] = groupVersionsIntoSessions([
      version(3, { summary: null }),
      version(2, { summary: null }),
    ]);

    expect(sessionSummary(session)).toBe('2 changes.');
  });

  it('names the version a restore came from', () => {
    const [session] = groupVersionsIntoSessions([
      version(6, { kind: 'restore', restoredFromVersion: 3, summary: null }),
    ]);

    expect(sessionSummary(session)).toBe('Restored version 3.');
  });
});

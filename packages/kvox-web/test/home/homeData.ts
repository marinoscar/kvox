/**
 * Data of the `home` slice's tests: the two summary answers the page reads, shaped
 * like the API's, and a host that serves them.
 */

import { createFakeKvoxWebHost } from '../../src/core/testing/index.js';
import type { FakeKvoxWebHost, FakeViewerInit } from '../../src/core/testing/index.js';
import type { NoteListItem, NoteSummary } from '../../src/notes/headless/index.js';
import type { TranscriptListItem, TranscriptSummary } from '../../src/transcripts/headless/index.js';

export const FIXED_ISO = '2024-03-01T09:00:00.000Z';

export function transcript(overrides: Partial<TranscriptListItem> = {}): TranscriptListItem {
  return {
    id: 't1',
    title: 'Weekly standup',
    status: 'ready',
    transcriptionStatus: 'completed',
    playbackStatus: 'ready',
    language: 'en',
    durationMs: 900_000,
    speakerCount: 3,
    wordCount: 2400,
    currentVersion: 1,
    failureReason: null,
    access: 'owner',
    hasAudio: true,
    recordedAt: FIXED_ISO,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    ...overrides,
  } as TranscriptListItem;
}

export function note(overrides: Partial<NoteListItem> = {}): NoteListItem {
  return {
    id: 'n1',
    title: 'Standup minutes',
    titleSource: 'ai',
    status: 'ready',
    currentVersion: 1,
    provider: 'openai',
    model: 'gpt-4o-mini',
    sourceType: 'transcript',
    sourceTranscriptId: 't1',
    sourceNoteId: null,
    sourceObjectId: null,
    templateId: 'tpl-1',
    templateName: 'Meeting minutes',
    sourceName: 'Weekly sync recording',
    currentGenerationId: null,
    failureReason: null,
    excerpt: 'The team agreed to ship the export dialog.',
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    ...overrides,
  } as NoteListItem;
}

export function transcriptSummary(overrides: Partial<TranscriptSummary> = {}): TranscriptSummary {
  const recent = overrides.recent ?? [];
  const shared = overrides.sharedWithMe ?? [];
  const inProgress = overrides.inProgress ?? [];
  const failed = overrides.failed ?? [];
  return {
    inProgress,
    recent,
    sharedWithMe: shared,
    failed,
    counts: {
      owned: recent.length + inProgress.length + failed.length,
      shared: shared.length,
      inProgress: inProgress.length,
      failed: failed.length,
      ...overrides.counts,
    },
  };
}

export function noteSummary(overrides: Partial<NoteSummary> = {}): NoteSummary {
  const recent = overrides.recent ?? [];
  const inProgress = overrides.inProgress ?? [];
  const failed = overrides.failed ?? [];
  return {
    inProgress,
    recent,
    failed,
    counts: {
      total: recent.length + inProgress.length + failed.length,
      ready: recent.length,
      inProgress: inProgress.length,
      failed: failed.length,
      ...overrides.counts,
    },
  };
}

export interface HomeHostOptions {
  viewer?: FakeViewerInit | null;
  transcripts?: TranscriptSummary;
  notes?: NoteSummary;
  graphEnabled?: boolean;
}

/** Every permission a person who can do everything on Home holds. */
export const ALL_HOME_PERMISSIONS = [
  'transcripts:read',
  'transcripts:write',
  'notes:read',
  'notes:write',
  'graph:read',
];

/**
 * A host with no API behind it: the two summaries are the only routes, and a call to
 * anything else fails the way an unrouted call does (the host answers 404).
 */
export function homeHost(options: HomeHostOptions = {}): FakeKvoxWebHost {
  return createFakeKvoxWebHost({
    viewer: options.viewer === undefined
      ? { userId: 'u1', permissions: ALL_HOME_PERMISSIONS, displayName: 'Ana Ruiz' }
      : options.viewer,
    features: { graphEnabled: options.graphEnabled ?? false },
    routes: {
      'GET /transcripts/summary': options.transcripts ?? transcriptSummary(),
      'GET /notes/summary': options.notes ?? noteSummary(),
    },
  });
}

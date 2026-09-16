/**
 * Fixtures shared by the home-page suites — issue #32, epic #19.
 *
 * NOT a `.test.ts` file, so `vitest.config.ts`'s
 * `include: ['src/**\/*.{test,spec}.{ts,tsx}']` never treats it as a suite with
 * no assertions in it.
 *
 * The point of collecting these here rather than re-declaring them per file is
 * that six suites render the same five components over the same shapes: a
 * divergence between "the transcript the card test renders" and "the transcript
 * the page test renders" is how a component passes its own suite and fails in
 * the page that mounts it.
 */

import { vi } from 'vitest';

import { mockUser, type MockUser } from '../../utils/test-utils';

import type { UploadManagerContextValue, ManagedUpload } from '../../../contexts/UploadManagerContext';
import type { NoteListItem, NoteSummary } from '../../../services/notes';
import type { TranscriptListItem, TranscriptSummary } from '../../../services/transcripts';
import type { UploadSessionRecord } from '../../../services/uploadSessions';
import type { TranscriptionConfig } from '../../../services/transcription';

/**
 * A fixed instant, never `Date.now()`.
 *
 * `formatRelativeTime` renders against the browser clock, so a fixture pinned
 * far enough in the past reads the same ("2 years ago") on every run, on every
 * machine, on every day — which is the only way an assertion on the metadata
 * line can be stable.
 */
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
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    ...overrides,
  };
}

export function summary(overrides: Partial<TranscriptSummary> = {}): TranscriptSummary {
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
      // ⚠ `failed` COUNTS TOWARDS `owned`, and it has to. `HomePage` reads
      // `counts.owned === 0` as part of `isNewUser`, so a fixture handed a
      // failed transcript while claiming the account owns nothing would render
      // the first-run walkthrough over the top of the very section under test.
      // Summed rather than de-duplicated (a real `failed` row is in `recent`
      // too) because the only consumer compares this number to zero.
      owned: recent.length + inProgress.length + failed.length,
      shared: shared.length,
      inProgress: inProgress.length,
      // DERIVED, like the notes fixture's — but overridable, because the API's
      // `counts.failed` is the TRUE total while `failed` is capped at eight,
      // and the "Showing 8 of 30" caption only exists to say so.
      failed: failed.length,
      ...overrides.counts,
    },
  };
}

/**
 * One note row — issue #107.
 *
 * `sourceType: 'transcript'` with a real `sourceTranscriptId`, because the
 * provenance line is part of every card and a row with no resolvable source
 * would silently exercise only the fallback path.
 */
export function note(overrides: Partial<NoteListItem> = {}): NoteListItem {
  return {
    id: 'n1',
    title: 'Standup minutes',
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
    currentGenerationId: null,
    failureReason: null,
    excerpt: 'The team agreed to ship the export dialog before the end of the month.',
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    ...overrides,
  };
}

/**
 * A whole `GET /api/notes/summary` answer — issue #107.
 *
 * The counts are DERIVED from the lists by default, exactly as `summary()`
 * above derives the transcript ones: a fixture whose `counts.total` disagreed
 * with its own `recent` would make `isNewUser` (which reads the count) and the
 * rendered list (which reads the array) tell two different stories, and the
 * suite asserting one of them would pass while the page was wrong.
 */
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

export const TRANSCRIPTION_AVAILABLE: TranscriptionConfig = {
  available: true,
  providerLabel: 'AssemblyAI',
  maxUploadBytes: 100_000_000,
  maxDurationMs: 7_200_000,
  acceptedExtensions: ['.m4a', '.mp3'],
  acceptedMimeTypes: ['audio/mp4', 'audio/mpeg'],
};

export const TRANSCRIPTION_UNAVAILABLE: TranscriptionConfig = {
  ...TRANSCRIPTION_AVAILABLE,
  available: false,
  providerLabel: null,
};

export function upload(overrides: Partial<ManagedUpload> = {}): ManagedUpload {
  return {
    id: 'obj-1',
    objectId: 'obj-1',
    transcriptId: 't-upload',
    fileName: 'interview.m4a',
    size: 40_000_000,
    startedAt: Date.parse(FIXED_ISO),
    resumed: false,
    ...overrides,
    progress: {
      phase: 'uploading',
      uploadedBytes: 10_000_000,
      totalBytes: 40_000_000,
      percent: 25,
      completedParts: 1,
      totalParts: 4,
      bytesPerSecond: 1_000_000,
      etaSeconds: 30,
      error: null,
      waitingForNetwork: false,
      ...overrides.progress,
    },
  };
}

export function session(overrides: Partial<UploadSessionRecord> = {}): UploadSessionRecord {
  return {
    objectId: 'obj-interrupted',
    transcriptId: 't-interrupted',
    fileName: 'board-meeting.m4a',
    size: 80_000_000,
    lastModified: Date.parse(FIXED_ISO),
    partSize: 8_000_000,
    createdAt: Date.parse(FIXED_ISO),
    ...overrides,
  };
}

export interface ManagerOverrides {
  uploads?: ManagedUpload[];
  sessions?: UploadSessionRecord[];
  pauseUpload?: UploadManagerContextValue['pauseUpload'];
  resumeUpload?: UploadManagerContextValue['resumeUpload'];
  cancelUpload?: UploadManagerContextValue['cancelUpload'];
  resumeFromSession?: UploadManagerContextValue['resumeFromSession'];
}

/**
 * A whole `useUploadManager` return value.
 *
 * The manager is mocked rather than stood up for real, which its own hook
 * header anticipates: it owns `XMLHttpRequest`s, IndexedDB sessions and a wake
 * lock, and none of the home page's behaviour depends on any of the three —
 * only on the array it publishes and the three callbacks the rows invoke.
 */
export function manager(overrides: ManagerOverrides = {}): UploadManagerContextValue {
  const uploads = overrides.uploads ?? [];
  return {
    uploads,
    activeUploads: uploads,
    sessions: overrides.sessions ?? [],
    sessionsLoading: false,
    keepScreenAwake: true,
    setKeepScreenAwake: vi.fn(),
    wakeLockSupported: true,
    wakeLockHeld: false,
    startUpload: vi.fn(),
    pauseUpload: overrides.pauseUpload ?? vi.fn(),
    resumeUpload: overrides.resumeUpload ?? vi.fn(),
    cancelUpload: overrides.cancelUpload ?? vi.fn().mockResolvedValue(undefined),
    dismissUpload: vi.fn(),
    resumeFromSession: overrides.resumeFromSession ?? vi.fn().mockResolvedValue(upload()),
    refreshSessions: vi.fn().mockResolvedValue(undefined),
    getUpload: vi.fn(),
  };
}

/**
 * jsdom performs no layout, so `color-contrast` cannot resolve an element's
 * effective background and is a well-known false-negative trap here. Every
 * other rule runs at full strength — the same posture, and the same reasoning,
 * as the transcripts library suite's own axe pass.
 */
export const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

/**
 * An ordinary (Viewer) account that can actually record something.
 *
 * `transcripts:read`/`:write` are seeded to ALL THREE roles
 * (`apps/api/prisma/seed.ts`), so a viewer fixture WITHOUT them is a user that
 * cannot exist — and a home page rendered for one would silently be a home page
 * with no call to action, asserted against as though that were the norm.
 * `mockUser` predates the transcripts permissions and is left alone here
 * because a dozen navigation suites derive expectations from its exact list.
 */
export const homeUser: MockUser = {
  ...mockUser,
  permissions: [
    ...mockUser.permissions,
    'transcripts:read',
    'transcripts:write',
    // `notes:*` is seeded to all three roles too (`apps/api/prisma/seed.ts`),
    // for the same stated reason: generating a note is the core product action,
    // not an operational surface. A home-page fixture without them would be a
    // user that cannot exist, asserted against as though it were the norm.
    'notes:read',
    'notes:write',
    // `GET /api/storage/objects/:id` is what resolves a document-sourced note's
    // name in `useNoteSourceNames`. Seeded to every role.
    'storage:read',
  ],
};

/** The same account with the notes permissions taken away. See #107's tests. */
export const noNotesUser: MockUser = {
  ...homeUser,
  permissions: homeUser.permissions.filter((p) => !p.startsWith('notes:')),
};

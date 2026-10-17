/**
 * Upload-manager fixtures for the transcripts suites: a managed upload, an
 * interrupted session and a whole `useUploadManager` value.
 *
 * The manager is mocked rather than stood up for real: it owns
 * `XMLHttpRequest`s, IndexedDB sessions and a wake lock, and none of what these
 * suites check depends on them, only on the array it publishes and the callbacks
 * the rows invoke.
 */

import { vi } from 'vitest';

import type {
  ManagedUpload,
  UploadManagerContextValue,
} from '../../src/transcripts/headless/upload/UploadManagerContext.js';
import type { UploadSessionRecord } from '../../src/transcripts/headless/clients/uploadSessions.js';

export const FIXED_ISO = '2024-03-01T09:00:00.000Z';

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


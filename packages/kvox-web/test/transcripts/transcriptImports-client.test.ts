import { describe, it, expect } from 'vitest';

import { KvoxApiError } from '../../src/core/headless/index.js';
import { createFakeKvoxWebHost, fakeApiError } from '../../src/core/testing/index.js';
import {
  TRANSCRIPT_IMPORT_MAX_BYTES,
  checkTranscriptImportFile,
  importTranscript,
  isImportedTranscript,
  transcriptImportErrorDetails,
  transcriptImportErrorMessage,
} from '../../src/transcripts/headless/clients/transcriptImports.js';

/**
 * The transcript import client (#571): the multipart call, the response parse,
 * and the copy each refusal becomes. Synthetic data only.
 */

const IMPORTED = {
  id: 'imp-1',
  title: 'Synthetic standup',
  status: 'ready',
  transcriptionStatus: 'completed',
  playbackStatus: 'not_needed',
  language: 'en',
  durationMs: 60_000,
  speakerCount: 2,
  wordCount: 120,
  currentVersion: 1,
  failureReason: null,
  access: 'owner',
  ownerName: 'Test User',
  hasAudio: false,
  recordedAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  speakers: [{ id: 'sp1', label: null, displayName: 'Ana', colorIndex: 0, rev: 1 }],
  provider: 'import',
  remoteDeletedAt: null,
  submittedAt: null,
  completedAt: '2026-01-01T00:00:00.000Z',
  sourceName: 'standup.json',
  sourceMimeType: 'application/json',
  sourceSizeBytes: '2048',
};

function jsonFile(name = 'standup.json', content = '{"schema":"kvox.transcript/v1"}'): File {
  return new File([content], name, { type: 'application/json' });
}

function refusal(details: unknown): KvoxApiError {
  return fakeApiError(400, 'Bad Request', details);
}

describe('importTranscript', () => {
  it('posts the file as the single `file` part and returns the parsed transcript', async () => {
    let seen: unknown;
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /transcripts/imports': (request) => {
          seen = request;
          return IMPORTED;
        },
      },
    });
    const file = jsonFile();

    const created = await importTranscript(host, file);

    expect(created.id).toBe('imp-1');
    expect(created.provider).toBe('import');
    const request = seen as { kind: string; body: FormData };
    expect(request.kind).toBe('formData');
    expect(request.body.getAll('file')).toHaveLength(1);
    expect((request.body.get('file') as File).name).toBe('standup.json');
  });

  it('rejects an answer that is not a transcript', async () => {
    const host = createFakeKvoxWebHost({ routes: { 'POST /transcripts/imports': { id: 42 } } });

    await expect(importTranscript(host, jsonFile())).rejects.toThrow();
  });

  it('surfaces a refusal as a KvoxApiError carrying the reason', async () => {
    const host = createFakeKvoxWebHost({
      routes: {
        'POST /transcripts/imports': () => {
          throw refusal({ reason: 'unsupported_schema', schema: 'kvox.transcript/v2' });
        },
      },
    });

    const error = await importTranscript(host, jsonFile()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(KvoxApiError);
    expect((error as KvoxApiError).reason).toBe('unsupported_schema');
  });
});

describe('transcriptImportErrorMessage', () => {
  it.each([
    ['not_json', 'That file is not valid JSON. Choose a transcript exported from KVox as JSON.'],
    ['unsupported_schema', "This isn't a KVox transcript export (kvox.transcript/v1)."],
    ['empty_transcript', 'This transcript export has no lines, so there is nothing to import.'],
  ])('words %s', (reason, message) => {
    expect(transcriptImportErrorMessage(refusal({ reason }))).toBe(message);
  });

  it('lists the first three issues of an invalid document and counts the rest', () => {
    const issues = Array.from({ length: 5 }, (_, index) => ({
      path: `transcript.segments.${index}.endMs`,
      message: 'Too small',
    }));

    const message = transcriptImportErrorMessage(refusal({ reason: 'invalid_document', issues }));

    expect(message).toBe(
      'This transcript export is not valid, so it was not imported. ' +
        'transcript.segments.0.endMs: Too small; transcript.segments.1.endMs: Too small; ' +
        'transcript.segments.2.endMs: Too small (and 2 more).',
    );
  });

  it('names the problem for an unknown speaker and a duplicate id', () => {
    const issues = [{ path: 'transcript.segments.0.speakerId', message: 'Unknown speaker "x"' }];

    expect(transcriptImportErrorMessage(refusal({ reason: 'unknown_speaker', issues }))).toBe(
      'A line in this transcript export names a speaker the file does not list, so it was not imported. ' +
        'transcript.segments.0.speakerId: Unknown speaker "x".',
    );
    expect(transcriptImportErrorMessage(refusal({ reason: 'duplicate_id' }))).toBe(
      'This transcript export repeats a speaker or line id, so it was not imported.',
    );
  });

  it('words a 400 without a reason (no file) and a 413', () => {
    expect(transcriptImportErrorMessage(fakeApiError(400, 'No file'))).toBe(
      'The file could not be read. Choose a transcript exported from KVox as JSON.',
    );
    expect(transcriptImportErrorMessage(fakeApiError(413, 'Payload Too Large'))).toBe(
      'That file is larger than this deployment accepts for an import.',
    );
  });

  it('falls back to a generic sentence for a network failure', () => {
    expect(transcriptImportErrorMessage(new TypeError('Failed to fetch'))).toBe(
      'The transcript could not be imported. Try again.',
    );
  });

  it('reads details only off a 400', () => {
    expect(transcriptImportErrorDetails(refusal({ reason: 'not_json' }))?.reason).toBe('not_json');
    expect(transcriptImportErrorDetails(fakeApiError(409, 'x', { reason: 'not_json' }))).toBeNull();
    expect(transcriptImportErrorDetails(refusal({ reason: 'something_else' }))).toBeNull();
  });
});

describe('checkTranscriptImportFile', () => {
  it('accepts a file within the limit and refuses an empty or oversized one', () => {
    expect(checkTranscriptImportFile({ size: 10 })).toBeNull();
    expect(checkTranscriptImportFile({ size: 0 })).toMatch(/empty/);
    expect(checkTranscriptImportFile({ size: TRANSCRIPT_IMPORT_MAX_BYTES + 1 })).toBe(
      'That file is too large to import. Transcript exports up to 25 MB can be imported.',
    );
  });
});

describe('isImportedTranscript', () => {
  it('is decided by the provider, not by playbackStatus', () => {
    expect(isImportedTranscript({ provider: 'import' })).toBe(true);
    expect(isImportedTranscript({ provider: 'AssemblyAI' })).toBe(false);
    expect(isImportedTranscript(null)).toBe(false);
  });
});

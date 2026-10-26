import { describe, expect, it } from 'vitest';

import { KvoxApiError } from '../../src/core/headless/index.js';
import { describeNoteImportFailure, noteImportUploadErrorMessage } from '../../src/notes/headless/utils/noteImportFailure.js';

const GENERIC = 'This file could not be imported. Try again, or check that it opens on your computer.';
const NOT_SET_UP = 'File storage is not set up on this server yet. An administrator can set it up in Settings → Storage.';

describe('describeNoteImportFailure', () => {
  it('words source_missing instead of falling back to the generic sentence', () => {
    const sentence = describeNoteImportFailure('source_missing');
    expect(sentence).toMatch(/uploaded copy/);
    expect(sentence).not.toBe(GENERIC);
  });

  it('keeps the generic sentence for an unknown code', () => {
    expect(describeNoteImportFailure('something_new')).toBe(GENERIC);
  });
});

describe('noteImportUploadErrorMessage', () => {
  it.each(['storage_not_configured', 'storage_bucket_unknown'])('words a 503 %s as "storage is not set up"', (reason) => {
    const error = new KvoxApiError('Storage is not configured', 503, 'SERVICE_UNAVAILABLE', {
      reason,
      remedy: 'Configure storage at /admin/settings/storage',
    });
    expect(noteImportUploadErrorMessage(error)).toBe(NOT_SET_UP);
  });

  it('keeps the server message for an unknown reason rather than the generic per-file sentence', () => {
    const error = new KvoxApiError('Service unavailable', 503, undefined, { reason: 'something_new' });
    expect(noteImportUploadErrorMessage(error)).toBe('Service unavailable');
  });

  it('still words known reasons and 413', () => {
    expect(noteImportUploadErrorMessage(new KvoxApiError('x', 400, undefined, { reason: 'unsupported_document' }))).toMatch(/cannot be imported/);
    expect(noteImportUploadErrorMessage(new KvoxApiError('x', 413))).toBe('This file is larger than the import limit.');
  });
});

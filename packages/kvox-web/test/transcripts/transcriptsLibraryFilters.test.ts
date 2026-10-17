import { describe, it, expect } from 'vitest';

import {
  TRANSCRIPT_STATUS_FILTERS,
  transcriptScopeFromQuery,
  transcriptStatusFromQuery,
} from '../../src/transcripts/headless/utils/transcriptsLibraryFilters.js';

/**
 * The transcripts library's deep-link parsers (issue #170, epic #166; moved with
 * the slice by #500, epic #498).
 *
 * Pure functions over `URLSearchParams`, which is why they are asserted here
 * rather than through a mounted page: the interesting rules are what happens to
 * input nobody typed deliberately (an unknown status, a missing parameter).
 */

function query(search: string): URLSearchParams {
  return new URLSearchParams(search);
}

describe('transcriptScopeFromQuery', () => {
  it('reads ?scope=shared', () => {
    expect(transcriptScopeFromQuery(query('?scope=shared'))).toBe('shared');
  });

  it('reads ?scope=owned', () => {
    expect(transcriptScopeFromQuery(query('?scope=owned'))).toBe('owned');
  });

  it('falls back to the user’s own transcripts for anything else', () => {
    // A broken link should land somebody on their own library, which is the
    // tab the page opens on anyway — never on an error.
    expect(transcriptScopeFromQuery(query(''))).toBe('owned');
    expect(transcriptScopeFromQuery(query('?scope=everything'))).toBe('owned');
    expect(transcriptScopeFromQuery(query('?scope='))).toBe('owned');
    // `all` is a real API scope with no tab to select. It is not a tab value.
    expect(transcriptScopeFromQuery(query('?scope=all'))).toBe('owned');
  });
});

describe('transcriptStatusFromQuery', () => {
  it('reads every status the page actually offers', () => {
    for (const option of TRANSCRIPT_STATUS_FILTERS) {
      expect(transcriptStatusFromQuery(query(`?status=${option.value}`))).toBe(option.value);
    }
  });

  it('falls back to "all" for an unknown status', () => {
    expect(transcriptStatusFromQuery(query('?status=bogus'))).toBe('all');
  });

  it('falls back to "all" when there is no status at all', () => {
    expect(transcriptStatusFromQuery(query(''))).toBe('all');
    expect(transcriptStatusFromQuery(query('?status='))).toBe('all');
  });
});

import { describe, expect, it } from 'vitest';

import { ASK_CONFLICT_REASONS, ASK_FINISH_REASONS } from '../src/ask/index.js';
import { KVOX_ERROR_CODES, isKvoxErrorCode } from '../src/errors/index.js';
import {
  DIGEST_UNAVAILABLE_REASONS,
  GRAPH_CONFLICT_REASONS,
  GRAPH_IMPORT_FAILURE_REASONS,
  PROPOSAL_BAD_REQUEST_REASONS,
} from '../src/graph/index.js';
import { NOTE_CONFLICT_REASONS, NOTE_IMPORT_FAILURE_REASONS } from '../src/notes/index.js';
import { SEMANTIC_REASONS } from '../src/search/index.js';
import { NAME_CHECK_CONFLICT_REASONS, TRANSCRIPT_IMPORT_FAILURE_REASONS } from '../src/transcripts/index.js';

/**
 * Every per-slice alias, with the status the API answers ALL its values with
 * (`null` when the list is a mix: body-carried reasons whose values are shared
 * with a 409 list).
 */
const ALIASES: ReadonlyArray<readonly [string, readonly string[], number | null]> = [
  ['GRAPH_CONFLICT_REASONS', Object.values(GRAPH_CONFLICT_REASONS), 409],
  ['NOTE_CONFLICT_REASONS', Object.values(NOTE_CONFLICT_REASONS), 409],
  ['NAME_CHECK_CONFLICT_REASONS', Object.values(NAME_CHECK_CONFLICT_REASONS), 409],
  ['ASK_CONFLICT_REASONS', ASK_CONFLICT_REASONS, 409],
  ['PROPOSAL_BAD_REQUEST_REASONS', Object.values(PROPOSAL_BAD_REQUEST_REASONS), 400],
  ['TRANSCRIPT_IMPORT_FAILURE_REASONS', Object.values(TRANSCRIPT_IMPORT_FAILURE_REASONS), 400],
  ['NOTE_IMPORT_FAILURE_REASONS', Object.values(NOTE_IMPORT_FAILURE_REASONS), 400],
  ['ASK_FINISH_REASONS', ASK_FINISH_REASONS, 200],
  ['DIGEST_UNAVAILABLE_REASONS', DIGEST_UNAVAILABLE_REASONS, null],
  ['GRAPH_IMPORT_FAILURE_REASONS', GRAPH_IMPORT_FAILURE_REASONS, 200],
  ['SEMANTIC_REASONS', SEMANTIC_REASONS, null],
];

describe('KVOX_ERROR_CODES', () => {
  it('keys every entry by its own code', () => {
    for (const [key, def] of Object.entries(KVOX_ERROR_CODES)) expect(def.code).toBe(key);
  });

  it('has no two entries with the same code', () => {
    const codes = Object.values(KVOX_ERROR_CODES).map((d) => d.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it.each(ALIASES)('holds every value of %s', (_name, values) => {
    for (const value of values) expect(isKvoxErrorCode(value), value).toBe(true);
  });

  it('lists each alias value exactly once across the catalogue', () => {
    const all = new Set(ALIASES.flatMap(([, values]) => values));
    // Every catalogue entry comes from some alias list, and the reverse.
    expect(new Set(Object.keys(KVOX_ERROR_CODES))).toEqual(all);
  });

  it.each(ALIASES.filter(([, , status]) => status !== null))(
    'answers every value of %s with the status of its list',
    (_name, values, status) => {
      for (const value of values) {
        expect(KVOX_ERROR_CODES[value as keyof typeof KVOX_ERROR_CODES].status).toBe(status);
      }
    },
  );

  it('rejects a string that is not a code', () => {
    expect(isKvoxErrorCode('nope')).toBe(false);
    expect(isKvoxErrorCode(409)).toBe(false);
    expect(isKvoxErrorCode('toString')).toBe(false);
  });
});

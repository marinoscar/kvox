/**
 * `utils/userDataDisplay.ts` — issue #80, Danger Zone.
 *
 * Both functions here are PURE, so the whole scope × summary matrix is
 * exercised directly, without rendering the dialog or the page. `formatBytes`
 * itself already has its own coverage via `transcriptDisplay`; what is new
 * here is the em-dash fallback `formatDataSize` adds on top, and the whole
 * inventory-sentence construction in `buildDeletionInventory`.
 */

import { describe, it, expect } from 'vitest';

import { buildDeletionInventory, formatDataSize } from '../../utils/userDataDisplay';
import type { UserDataScope, UserDataSummary } from '../../services/userData';

// =============================================================================
// formatDataSize
// =============================================================================

describe('formatDataSize', () => {
  it.each([null, undefined, ''])('renders an em dash for %j rather than a confident "0 B"', (value) => {
    expect(formatDataSize(value as never)).toBe('—');
  });

  it('renders an em dash for a value that does not parse as a number', () => {
    expect(formatDataSize('not-a-number')).toBe('—');
  });

  it('renders an em dash for a negative value', () => {
    expect(formatDataSize('-5')).toBe('—');
  });

  it('renders "0 B" for a genuine zero, distinct from the missing/unparseable em dash', () => {
    expect(formatDataSize('0')).toBe('0 B');
  });

  it('renders one decimal place below 10 units', () => {
    // 1.3 GB, decimal (1000-based), matching the docstring's own example.
    expect(formatDataSize('1300000000')).toBe('1.3 GB');
  });

  it('rounds to a whole number at 10 units and above', () => {
    expect(formatDataSize('45000000000')).toBe('45 GB');
  });
});

// =============================================================================
// buildDeletionInventory
// =============================================================================

/** A summary with every category at zero — the "nothing stored" baseline. */
function emptySummary(overrides: Partial<UserDataSummary> = {}): UserDataSummary {
  return {
    transcripts: { count: 0, bytes: '0' },
    notes: { count: 0, bytes: '0' },
    files: { count: 0, bytes: '0' },
    noteTemplates: { count: 0 },
    credentials: { aiKeys: 0, accessTokens: 0 },
    graph: { entities: 0, items: 0 },
    activeDeletion: null,
    ...overrides,
  };
}

const NARROW_SCOPES: UserDataScope[] = ['transcripts', 'notes', 'files'];
const COMPOUND_SCOPES: UserDataScope[] = ['content', 'everything'];

describe('buildDeletionInventory', () => {
  // ==========================================================================
  // The four shapes, exactly
  // ==========================================================================

  it('returns null when the summary is null, regardless of scope', () => {
    for (const scope of [...NARROW_SCOPES, ...COMPOUND_SCOPES]) {
      expect(buildDeletionInventory(scope, null)).toBeNull();
    }
  });

  it.each(NARROW_SCOPES)(
    'returns null for the narrow "%s" scope even with a real summary — its one category was already read on the row the user clicked',
    (scope) => {
      const summary = emptySummary({
        transcripts: { count: 4, bytes: '900000000' },
        notes: { count: 8, bytes: '300000000' },
        files: { count: 2, bytes: '100000000' },
      });
      expect(buildDeletionInventory(scope, summary)).toBeNull();
    },
  );

  it('renders "nothing stored" when every category the scope covers is zero', () => {
    for (const scope of COMPOUND_SCOPES) {
      expect(buildDeletionInventory(scope, emptySummary())).toBe(
        'There is nothing stored for your account right now.',
      );
    }
  });

  it('omits the total when no covered category carries bytes, even though items exist', () => {
    // `everything` scope, only a personal access token — a count-only category
    // (`credentials`) with nothing else present, so there is no size to state.
    const summary = emptySummary({ credentials: { aiKeys: 0, accessTokens: 1 } });
    summary.transcripts = { count: 1, bytes: '0' };

    expect(buildDeletionInventory('everything', summary)).toBe(
      'Right now that is 1 recording and 1 personal access token.',
    );
  });

  it('states the total in parentheses once a covered category carries bytes', () => {
    const summary = emptySummary({
      transcripts: { count: 4, bytes: '900000000' },
      notes: { count: 8, bytes: '300000000' },
      files: { count: 2, bytes: '100000000' },
      noteTemplates: { count: 5 },
    });

    expect(buildDeletionInventory('content', summary)).toBe(
      'Right now that is 4 recordings, 8 notes, 5 note templates and 2 files (1.3 GB in total).',
    );
  });

  // ==========================================================================
  // The pinned literals, verbatim — issue #80's acceptance text
  // ==========================================================================

  it('pins the four exact sentences the issue specifies', () => {
    const richSummary = emptySummary({
      transcripts: { count: 4, bytes: '900000000' },
      notes: { count: 8, bytes: '300000000' },
      files: { count: 2, bytes: '100000000' },
      noteTemplates: { count: 5 },
    });

    expect(buildDeletionInventory('content', richSummary)).toBe(
      'Right now that is 4 recordings, 8 notes, 5 note templates and 2 files (1.3 GB in total).',
    );

    expect(
      buildDeletionInventory('everything', {
        ...richSummary,
        credentials: { aiKeys: 1, accessTokens: 2 },
      }),
    ).toBe(
      'Right now that is 4 recordings, 8 notes, 5 note templates, 2 files, 1 AI provider key and 2 personal access tokens (1.3 GB in total).',
    );

    expect(
      buildDeletionInventory('everything', {
        ...emptySummary(),
        transcripts: { count: 1, bytes: '0' },
        credentials: { aiKeys: 0, accessTokens: 1 },
      }),
    ).toBe('Right now that is 1 recording and 1 personal access token.');

    expect(buildDeletionInventory('everything', emptySummary())).toBe(
      'There is nothing stored for your account right now.',
    );
  });

  // ==========================================================================
  // Ordering, singular/plural, zero-omission
  // ==========================================================================

  it('joins in the fixed order — recordings, notes, note templates, files, AI provider keys, personal access tokens, graph entities, graph facts', () => {
    // Populate in the REVERSE order to prove the sentence order is not simply
    // "the order the fields happened to be set in".
    const summary = emptySummary({
      graph: { entities: 1, items: 1 },
      credentials: { aiKeys: 1, accessTokens: 1 },
      noteTemplates: { count: 1 },
      files: { count: 1, bytes: '0' },
      notes: { count: 1, bytes: '0' },
      transcripts: { count: 1, bytes: '0' },
    });

    expect(buildDeletionInventory('everything', summary)).toBe(
      'Right now that is 1 recording, 1 note, 1 note template, 1 file, 1 AI provider key, 1 personal access token, 1 knowledge graph entity and 1 knowledge graph fact.',
    );
  });

  it('uses the singular noun at exactly 1 and the plural otherwise, for every category', () => {
    const singular = emptySummary({
      transcripts: { count: 1, bytes: '0' },
      notes: { count: 1, bytes: '0' },
      files: { count: 1, bytes: '0' },
      noteTemplates: { count: 1 },
      credentials: { aiKeys: 1, accessTokens: 1 },
      graph: { entities: 1, items: 1 },
    });
    expect(buildDeletionInventory('everything', singular)).toBe(
      'Right now that is 1 recording, 1 note, 1 note template, 1 file, 1 AI provider key, 1 personal access token, 1 knowledge graph entity and 1 knowledge graph fact.',
    );

    const plural = emptySummary({
      transcripts: { count: 2, bytes: '0' },
      notes: { count: 2, bytes: '0' },
      files: { count: 2, bytes: '0' },
      noteTemplates: { count: 2 },
      credentials: { aiKeys: 2, accessTokens: 2 },
      graph: { entities: 2, items: 2 },
    });
    expect(buildDeletionInventory('everything', plural)).toBe(
      'Right now that is 2 recordings, 2 notes, 2 note templates, 2 files, 2 AI provider keys, 2 personal access tokens, 2 knowledge graph entities and 2 knowledge graph facts.',
    );
  });

  it('omits a zero-count category entirely rather than rendering "0 notes"', () => {
    const summary = emptySummary({
      transcripts: { count: 3, bytes: '0' },
      notes: { count: 0, bytes: '0' },
    });

    const result = buildDeletionInventory('content', summary)!;
    expect(result).not.toMatch(/0 notes/);
    expect(result).toBe('Right now that is 3 recordings.');
  });

  // ==========================================================================
  // The BigInt total: unparseable is dropped from the total only, and nothing
  // is silently left out of a total that legitimately has several parts
  // ==========================================================================

  it('drops an unparseable bytes value from the TOTAL, without discarding that item’s own count', () => {
    const summary = emptySummary({
      transcripts: { count: 2, bytes: '500000000' },
      notes: { count: 3, bytes: 'not-a-number' },
    });

    const result = buildDeletionInventory('content', summary)!;
    // Both item counts survive the bad `bytes` value on one of them.
    expect(result).toContain('2 recordings');
    expect(result).toContain('3 notes');
    // Only the parseable category's bytes reach the total.
    expect(result).toBe('Right now that is 2 recordings and 3 notes (500 MB in total).');
  });

  it('sums every covered category that carries bytes — not just the first one with a nonzero value', () => {
    // Three distinct, individually-checkable magnitudes so a regression that
    // summed only one category (or dropped one silently) produces a visibly
    // wrong total rather than one that could coincidentally look right.
    const summary = emptySummary({
      transcripts: { count: 1, bytes: '100000000' }, // 100 MB
      notes: { count: 1, bytes: '10000000' }, // 10 MB
      files: { count: 1, bytes: '1000000' }, // 1 MB
    });

    expect(buildDeletionInventory('content', summary)).toBe(
      'Right now that is 1 recording, 1 note and 1 file (111 MB in total).',
    );
  });

  it('note templates carry no byte weight and never appear inside the size total, only the item count', () => {
    const summary = emptySummary({ noteTemplates: { count: 3 } });

    expect(buildDeletionInventory('content', summary)).toBe(
      'Right now that is 3 note templates.',
    );
  });

  // #357: the graph is a category of `content`/`everything`, counted in rows.
  it('names the knowledge graph for both compound scopes, with no byte weight, omitting a zero count', () => {
    const summary = emptySummary({
      transcripts: { count: 1, bytes: '1000000' },
      graph: { entities: 4, items: 0 },
    });

    for (const scope of COMPOUND_SCOPES) {
      expect(buildDeletionInventory(scope, summary)).toBe(
        'Right now that is 1 recording and 4 knowledge graph entities (1.0 MB in total).',
      );
    }
  });

  it('a graph-only account is not reported as having nothing stored', () => {
    const summary = emptySummary({ graph: { entities: 0, items: 2 } });

    expect(buildDeletionInventory('content', summary)).toBe(
      'Right now that is 2 knowledge graph facts.',
    );
  });
});

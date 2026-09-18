// =============================================================================
// The user-data module's queue vocabulary (issue #80)
// =============================================================================
//
// `scopeIncludes` is the ONE definition of what each scope means, shared by
// the controller (request time) and the purge handler (run time) — see the
// file's own header. This spec pins the full 5x5 matrix exhaustively, because
// a regression here does not fail loudly: it silently widens or narrows what
// a scope destroys, and the two call sites are separated by a queue and by
// minutes, so nothing would report the disagreement.
// =============================================================================

import {
  confirmationFor,
  scopeIncludes,
  USER_DATA_PURGE_JOB_TYPE,
  USER_DATA_SCOPES,
  USER_DATA_SUBJECT_TYPE,
  type UserDataScope,
} from './job-types';

const CATEGORIES = [
  'transcripts',
  'notes',
  'noteTemplates',
  'files',
  'credentials',
  'onboarding',
] as const;

describe('user.data.purge job type strings', () => {
  it('are the permanent strings a queued payload records', () => {
    // ⚠ PERMANENT ONCE A JOB CARRIES ONE — see the file header. A rename here
    // is a data migration over every row already queued, running or in the
    // history under the old name.
    expect(USER_DATA_PURGE_JOB_TYPE).toBe('user.data.purge');
    expect(USER_DATA_SUBJECT_TYPE).toBe('user');
  });

  it('lists the five scopes narrowest-first, in the order the UI renders', () => {
    expect(USER_DATA_SCOPES).toEqual(['transcripts', 'notes', 'files', 'content', 'everything']);
  });
});

describe('scopeIncludes — the full scope x category matrix', () => {
  // The settled semantics, stated once as data rather than as five separate
  // `expect` calls per scope, so the table itself is the spec.
  const MATRIX: Record<UserDataScope, Record<(typeof CATEGORIES)[number], boolean>> = {
    transcripts: {
      transcripts: true,
      notes: false,
      noteTemplates: false,
      files: false,
      credentials: false,
      onboarding: false,
    },
    notes: {
      transcripts: false,
      notes: true,
      noteTemplates: false,
      files: false,
      credentials: false,
      onboarding: false,
    },
    files: {
      transcripts: false,
      notes: false,
      noteTemplates: false,
      files: true,
      credentials: false,
      onboarding: false,
    },
    content: {
      transcripts: true,
      notes: true,
      noteTemplates: true,
      files: true,
      credentials: false,
      onboarding: false,
    },
    everything: {
      transcripts: true,
      notes: true,
      noteTemplates: true,
      files: true,
      credentials: true,
      onboarding: true,
    },
  };

  const cases: Array<[UserDataScope, (typeof CATEGORIES)[number], boolean]> = USER_DATA_SCOPES.flatMap(
    (scope) =>
      CATEGORIES.map(
        (category): [UserDataScope, (typeof CATEGORIES)[number], boolean] => [
          scope,
          category,
          MATRIX[scope][category],
        ],
      ),
  );

  it.each(cases)('scope "%s" x category "%s" -> %s', (scope, category, expected) => {
    expect(scopeIncludes(scope, category)).toBe(expected);
  });

  it('gives every narrow scope EXACTLY one category and nothing else', () => {
    for (const narrow of ['transcripts', 'notes', 'files'] as const) {
      const included = CATEGORIES.filter((category) => scopeIncludes(narrow, category));

      expect(included).toEqual([narrow]);
    }
  });

  it('composes `content` as transcripts + notes + noteTemplates + files, with NO credentials', () => {
    expect(scopeIncludes('content', 'transcripts')).toBe(true);
    expect(scopeIncludes('content', 'notes')).toBe(true);
    expect(scopeIncludes('content', 'noteTemplates')).toBe(true);
    expect(scopeIncludes('content', 'files')).toBe(true);
    expect(scopeIncludes('content', 'credentials')).toBe(false);
  });

  it('composes `everything` as `content` plus credentials AND onboarding, the only two lines the composites differ on', () => {
    for (const category of CATEGORIES) {
      if (category === 'credentials' || category === 'onboarding') continue;

      expect(scopeIncludes('everything', category)).toBe(scopeIncludes('content', category));
    }

    expect(scopeIncludes('content', 'credentials')).toBe(false);
    expect(scopeIncludes('everything', 'credentials')).toBe(true);
    expect(scopeIncludes('content', 'onboarding')).toBe(false);
    expect(scopeIncludes('everything', 'onboarding')).toBe(true);
  });

  // ⚠ THE REGRESSION THIS TEST EXISTS TO CATCH: silently reaching note
  // templates from the narrow `notes` scope would empty a user's
  // `/settings/note-templates` page the moment they clicked "Delete notes" —
  // a settings surface they never opened, deleting hand-written recipes that
  // have no provider, no bucket and no recording to rebuild them from. This
  // was a deliberate, argued reversal (see `scopeIncludes`'s own comment); a
  // regression here silently empties that page with no error anywhere.
  it('keeps note templates out of the narrow `notes` scope, so "Delete notes" never silently empties /settings/note-templates', () => {
    expect(scopeIncludes('notes', 'noteTemplates')).toBe(false);
  });

  it('reaches note templates ONLY from `content` and `everything` — never from a narrow scope', () => {
    for (const scope of USER_DATA_SCOPES) {
      const reachable = scopeIncludes(scope, 'noteTemplates');
      const isComposite = scope === 'content' || scope === 'everything';

      expect(reachable).toBe(isComposite);
    }
  });

  it('reaches credentials ONLY from `everything` — not even from `content`', () => {
    for (const scope of USER_DATA_SCOPES) {
      const reachable = scopeIncludes(scope, 'credentials');

      expect(reachable).toBe(scope === 'everything');
    }
  });

  // ⚠ THE REGRESSION THIS PAIR EXISTS TO CATCH, in both directions.
  //
  // Too narrow: without `everything` reaching `onboarding`, a user who wipes
  // their account keeps `welcomeSeenAt`/`dismissedAt`, and the checklist —
  // which correctly regresses on its own, because it is derived live — is
  // never shown again. Nothing errors; the guidance simply stops appearing,
  // and the only way back is a replay button on a settings page they have no
  // reason to open.
  //
  // Too wide: `content` reaching `onboarding` would reset a user's first-run
  // state for "delete my content", which is not the request they made — and
  // the three narrow scopes reaching it would be worse still, since "delete my
  // files" would restart a welcome tour.
  it('reaches onboarding ONLY from `everything` — never from `content`, never from a narrow scope', () => {
    for (const scope of USER_DATA_SCOPES) {
      const reachable = scopeIncludes(scope, 'onboarding');

      expect(reachable).toBe(scope === 'everything');
    }
  });

  it('keeps onboarding out of every scope but `everything`, one explicit assertion per scope', () => {
    expect(scopeIncludes('transcripts', 'onboarding')).toBe(false);
    expect(scopeIncludes('notes', 'onboarding')).toBe(false);
    expect(scopeIncludes('files', 'onboarding')).toBe(false);
    expect(scopeIncludes('content', 'onboarding')).toBe(false);
    expect(scopeIncludes('everything', 'onboarding')).toBe(true);
  });

  // ⚠ `onboarding` IS A STEP, NOT A REQUESTABLE SCOPE. The category union in
  // `scopeIncludes` names what a scope fans out TO; `USER_DATA_SCOPES` names
  // what a caller may ASK for, and its strings are permanent once a queued
  // payload records one. Adding `'onboarding'` there would create a
  // "delete my onboarding state" request that destroys nothing and that the
  // replay button on `/settings/getting-started` already provides.
  it('does NOT add `onboarding` to the requestable scopes — those five strings are permanent', () => {
    expect(USER_DATA_SCOPES).toEqual(['transcripts', 'notes', 'files', 'content', 'everything']);
    expect(USER_DATA_SCOPES).not.toContain('onboarding');
  });
});

describe('confirmationFor', () => {
  it.each(USER_DATA_SCOPES)('is the scope "%s" uppercased, with no lookup table to drift from it', (scope) => {
    expect(confirmationFor(scope)).toBe(scope.toUpperCase());
  });

  it('gives every scope a distinct token', () => {
    const tokens = USER_DATA_SCOPES.map((scope) => confirmationFor(scope));

    expect(new Set(tokens).size).toBe(USER_DATA_SCOPES.length);
  });

  // ⚠ THE WHOLE POINT: a word typed into one dialog cannot authorise another
  // action. Every ordered pair of distinct scopes must fail this check — the
  // literal for scope A must not equal, and therefore must not validate, a
  // request for scope B.
  const crossScopePairs: Array<[UserDataScope, UserDataScope]> = USER_DATA_SCOPES.flatMap((a) =>
    USER_DATA_SCOPES.filter((b) => b !== a).map((b): [UserDataScope, UserDataScope] => [a, b]),
  );

  it.each(crossScopePairs)('the "%s" confirmation word does not authorise a "%s" request', (scopeA, scopeB) => {
    expect(confirmationFor(scopeA)).not.toBe(confirmationFor(scopeB));
  });
});

import { describe, it, expect } from 'vitest';

import { buildRegenerateInput } from '../../../components/notes/regenerateInput';
import type { RegenerateNoteFields } from '../../../components/notes/regenerateInput';

/**
 * `buildRegenerateInput` — issue #109, epic #45.
 *
 * The request body is the whole feature: the dialog's three controls mean
 * nothing if what reaches `POST /api/notes/{id}/regenerate` is a snapshot
 * rather than a diff. So this suite asserts the BODY, key by key, including the
 * two cases with no visible symptom — the empty object, and the explicit
 * `null`.
 */

function note(overrides: Partial<RegenerateNoteFields> = {}): RegenerateNoteFields {
  return {
    templateId: 'tpl-1',
    contextText: 'Ana and Ben, the quarterly review.',
    model: 'gpt-4o-mini',
    ...overrides,
  };
}

/** The form as it opens on an untouched note. */
function form(overrides: Partial<Record<'templateId' | 'contextText' | 'model', string>> = {}) {
  return {
    templateId: 'tpl-1',
    contextText: 'Ana and Ben, the quarterly review.',
    model: 'gpt-4o-mini',
    ...overrides,
  };
}

describe('buildRegenerateInput — nothing changed', () => {
  it('produces `{}` — byte-for-byte the request #58 sent', () => {
    // ⚠ THE COMPATIBILITY ASSERTION. A user who opens the dialog and presses
    // Regenerate must produce exactly the body the confirm-only dialog
    // produced, or this feature has silently changed what "the same again"
    // means.
    expect(buildRegenerateInput(note(), form())).toEqual({});
  });

  it('treats whitespace the user did not mean to add as no change at all', () => {
    // A stray trailing newline in a textarea is not a reason to re-run a model
    // on somebody's own provider account.
    expect(
      buildRegenerateInput(note(), form({ contextText: '  Ana and Ben, the quarterly review.\n' })),
    ).toEqual({});
  });

  it('produces `{}` for a note that has no context and a form that still has none', () => {
    expect(
      buildRegenerateInput(note({ contextText: null }), form({ contextText: '   ' })),
    ).toEqual({});
  });

  it('produces `{}` for a note with no template and no model recorded', () => {
    expect(
      buildRegenerateInput(
        { templateId: null, contextText: null, model: null },
        { templateId: '', contextText: '', model: '' },
      ),
    ).toEqual({});
  });
});

describe('buildRegenerateInput — the template', () => {
  it('sends it when it differs', () => {
    expect(buildRegenerateInput(note(), form({ templateId: 'tpl-2' }))).toEqual({
      templateId: 'tpl-2',
    });
  });

  it('sends it when the note had none', () => {
    // The API nulls `templateId` when the template row is deleted; choosing one
    // is the only way such a note can be regenerated at all.
    expect(
      buildRegenerateInput(note({ templateId: null }), form({ templateId: 'tpl-9' })),
    ).toEqual({ templateId: 'tpl-9' });
  });

  it('NEVER sends an empty string, even though it differs from the note', () => {
    // ⚠ `templateId` IS `string | undefined` ON THE WIRE — there is no way to
    // express "no template", so `''` would be a 400 on a request the user
    // believes is "regenerate". The dialog disables its confirm on this state;
    // this is the guard that makes the builder safe for any other caller.
    expect(buildRegenerateInput(note(), form({ templateId: '' }))).toEqual({});
  });
});

describe('buildRegenerateInput — the context', () => {
  it('sends the trimmed text when it was changed', () => {
    expect(
      buildRegenerateInput(note(), form({ contextText: '  Ana, Ben and Cleo.  ' })),
    ).toEqual({ contextText: 'Ana, Ben and Cleo.' });
  });

  it('sends `null` — not an omission — when the user cleared text the note had', () => {
    // ⚠ THE CASE THE WHOLE FILE EXISTS FOR. Omitting an emptied box would
    // regenerate with the very context the user just deleted, and nothing on
    // screen would say so.
    expect(buildRegenerateInput(note(), form({ contextText: '' }))).toEqual({
      contextText: null,
    });
  });

  it('sends `null` for a box cleared down to whitespace', () => {
    expect(buildRegenerateInput(note(), form({ contextText: '   \n  ' }))).toEqual({
      contextText: null,
    });
  });

  it('sends text added to a note that had none', () => {
    expect(
      buildRegenerateInput(note({ contextText: null }), form({ contextText: 'New context.' })),
    ).toEqual({ contextText: 'New context.' });
  });
});

describe('buildRegenerateInput — the model', () => {
  it('sends it when it differs', () => {
    expect(buildRegenerateInput(note(), form({ model: 'gpt-4o' }))).toEqual({
      model: 'gpt-4o',
    });
  });

  it('sends it when the note recorded none', () => {
    expect(buildRegenerateInput(note({ model: null }), form({ model: 'gpt-4o' }))).toEqual({
      model: 'gpt-4o',
    });
  });

  it('NEVER sends an empty string — an unanswered `GET /api/ai/config` is not a choice', () => {
    expect(buildRegenerateInput(note(), form({ model: '' }))).toEqual({});
  });
});

describe('buildRegenerateInput — several changes at once', () => {
  it('carries exactly the keys that moved, and no others', () => {
    expect(
      buildRegenerateInput(
        note(),
        form({ templateId: 'tpl-2', model: 'gpt-4o', contextText: 'Ana and Ben, the quarterly review.' }),
      ),
    ).toEqual({ templateId: 'tpl-2', model: 'gpt-4o' });
  });

  it('can change all three in one request', () => {
    expect(
      buildRegenerateInput(
        note(),
        form({ templateId: 'tpl-2', contextText: 'Different.', model: 'gpt-4o' }),
      ),
    ).toEqual({ templateId: 'tpl-2', contextText: 'Different.', model: 'gpt-4o' });
  });
});

/**
 * The caller's note templates and the seeded built-ins — issue #56, epic #45.
 *
 * ONE LIST, NOT TWO. `GET /api/note-templates` returns both kinds in one
 * response, each flagged `builtIn`, and this hook keeps them that way rather
 * than splitting them into `mine` / `builtIns` on arrival. A split here would
 * be a second place the "which affordances does this row get?" question is
 * answered, and the answer is already one field on one row.
 *
 * Shaped after `useAiCredential`: one read, `isMounted()` after every await, a
 * per-action error that is a STRING the page renders rather than an exception
 * the page has to catch. Every mutation returns the row (or `null`), so a
 * caller can act on success without re-reading the list.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../services/api';
import {
  createNoteTemplate,
  deleteNoteTemplate,
  duplicateNoteTemplate,
  getNoteTemplate,
  getNoteTemplates,
  hideNoteTemplate,
  unhideNoteTemplate,
  updateNoteTemplate,
} from '../services/noteTemplates';
import type {
  CreateNoteTemplateInput,
  DeleteNoteTemplateResult,
  NoteTemplate,
  UpdateNoteTemplateInput,
} from '../services/noteTemplates';
import { useIsMounted } from './useIsMounted';

/**
 * Turn a rejection into a sentence.
 *
 * ⚠ 403 AND 404 ARE DIFFERENT SENTENCES, and collapsing them would waste the
 * distinction the API went out of its way to make: a 403 on a write means the
 * row is a built-in (its existence is public, it is simply immutable, and
 * Duplicate is the way through), while a 404 means the row is not the caller's
 * to see at all — a list that has gone stale. One "could not save" string for
 * both would tell a user to retry something that can never succeed.
 */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) {
      return 'Built-in templates cannot be changed. Duplicate it to make an editable copy.';
    }
    if (err.status === 404) {
      return 'That template no longer exists. Refresh to see the current list.';
    }
    return err.message || fallback;
  }
  return fallback;
}

export interface UseNoteTemplatesReturn {
  templates: NoteTemplate[];
  isLoading: boolean;
  loadError: string | null;
  isSaving: boolean;
  actionError: string | null;
  clearActionError: () => void;
  refresh: () => Promise<void>;
  create: (input: CreateNoteTemplateInput) => Promise<NoteTemplate | null>;
  update: (id: string, input: UpdateNoteTemplateInput) => Promise<NoteTemplate | null>;
  duplicate: (id: string) => Promise<NoteTemplate | null>;
  archive: (id: string) => Promise<DeleteNoteTemplateResult | null>;
  /**
   * Hide a template from (or show it in) the caller's template pickers — issue
   * #311. OPTIMISTIC: the row flips (or, in a list that excludes hidden rows,
   * disappears) before the request is sent, and is put back if it fails, with
   * the reason in `actionError`. Resolves `true` on success.
   */
  setHidden: (id: string, hidden: boolean) => Promise<boolean>;
}

export interface UseNoteTemplatesOptions {
  /**
   * Include templates the caller has hidden. Default `false`, which is what
   * every PICKER wants — a hidden template must never be offered, least of all
   * pre-selected. Only the template manager asks for them.
   */
  includeHidden?: boolean;
}

export function useNoteTemplates(
  options: UseNoteTemplatesOptions = {},
): UseNoteTemplatesReturn {
  const includeHidden = options.includeHidden ?? false;
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const list = await getNoteTemplates(includeHidden ? { includeHidden: true } : {});
      if (isMounted()) setTemplates(list.items);
    } catch (err) {
      if (isMounted()) {
        setLoadError(messageFor(err, 'Failed to load your note templates'));
        setTemplates([]);
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [includeHidden, isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The latest list, readable from inside `setHidden` without making the
  // callback's identity change on every render.
  const templatesRef = useRef(templates);
  templatesRef.current = templates;

  /**
   * Every mutation runs through here, so the in-flight flag, the error reset
   * and the list refresh cannot be half-applied by one call site that forgot a
   * `finally`.
   */
  const run = useCallback(
    async <T>(action: () => Promise<T>, fallback: string): Promise<T | null> => {
      setIsSaving(true);
      setActionError(null);
      try {
        const result = await action();
        // Re-read rather than splice the local array: `DELETE` may have
        // ARCHIVED instead of deleted, and `duplicate` produces a row with a
        // server-chosen name. Guessing either would show the user something
        // the server did not do.
        await refresh();
        return result;
      } catch (err) {
        if (isMounted()) setActionError(messageFor(err, fallback));
        return null;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [isMounted, refresh],
  );

  const create = useCallback(
    (input: CreateNoteTemplateInput) =>
      run(() => createNoteTemplate(input), 'Failed to create the template'),
    [run],
  );

  const update = useCallback(
    (id: string, input: UpdateNoteTemplateInput) =>
      run(() => updateNoteTemplate(id, input), 'Failed to save the template'),
    [run],
  );

  const duplicate = useCallback(
    (id: string) => run(() => duplicateNoteTemplate(id), 'Failed to duplicate the template'),
    [run],
  );

  const archive = useCallback(
    (id: string) => run(() => deleteNoteTemplate(id), 'Failed to archive the template'),
    [run],
  );

  const setHidden = useCallback(
    async (id: string, hidden: boolean): Promise<boolean> => {
      const index = templatesRef.current.findIndex((template) => template.id === id);
      const original = index >= 0 ? templatesRef.current[index] : null;
      const removeLocally = hidden && !includeHidden;

      setActionError(null);
      setTemplates((current) =>
        removeLocally
          ? current.filter((template) => template.id !== id)
          : current.map((template) => (template.id === id ? { ...template, hidden } : template)),
      );

      try {
        await (hidden ? hideNoteTemplate(id) : unhideNoteTemplate(id));
        return true;
      } catch (err) {
        if (!isMounted()) return false;
        // Roll back THIS ROW only, not the whole list: another toggle may be in
        // flight, and restoring a stale snapshot would undo it too.
        setTemplates((current) => {
          if (current.some((template) => template.id === id)) {
            return current.map((template) =>
              template.id === id ? { ...template, hidden: !hidden } : template,
            );
          }
          if (!original) return current;
          const next = [...current];
          next.splice(Math.min(index, next.length), 0, original);
          return next;
        });
        setActionError(
          err instanceof ApiError && err.status === 404
            ? 'This template no longer exists.'
            : messageFor(err, hidden ? 'Failed to hide the template' : 'Failed to show the template'),
        );
        return false;
      }
    },
    [includeHidden, isMounted],
  );

  return {
    templates,
    isLoading,
    loadError,
    isSaving,
    actionError,
    clearActionError: () => setActionError(null),
    refresh,
    create,
    update,
    duplicate,
    archive,
    setHidden,
  };
}

// =============================================================================
// ONE template, read by id — issue #109, epic #45
// =============================================================================

/**
 * What a note page knows about the template its note was generated from.
 *
 * ⚠ `missing` IS NOT `error`, AND THE DIFFERENCE IS THE WHOLE POINT OF THIS
 * TYPE. `GET /api/note-templates/{id}` answers **404** for a template that is
 * not the caller's and not a built-in, and **403** for a write against a
 * built-in; either way, for a READ, both mean "you cannot see this row" — a
 * permanent answer for this user, produced by the API working exactly as
 * designed. A note generated from a template that was later deleted, or from
 * one shared into a workspace this user has since left, is an ORDINARY note,
 * and the panel that describes it says so in a sentence.
 *
 * Collapsing that into `error` would put a red "could not load" in front of a
 * user whose note is fine, and — worse — would invite a Retry affordance for a
 * request whose answer can never change. So the two live in one union and every
 * consumer branches on it.
 *
 * `idle` is the fifth member and the reason the union is not four: a note whose
 * `templateId` is `null` (the template was deleted and the API nulled the
 * column) asks NOTHING, and must be distinguishable from one whose request has
 * not come back yet. A four-member union would have had to spell that as
 * `loading` forever.
 */
export interface UseNoteTemplateDetailResult {
  template: NoteTemplate | null;
  state: 'idle' | 'loading' | 'loaded' | 'missing' | 'error';
  /** Set only in the `error` state; `null` everywhere else, `missing` included. */
  error: string | null;
}

/**
 * Frozen module constants rather than fresh objects.
 *
 * Every consumer of this hook puts `result.state` in a dependency array or a
 * render branch; handing back a new object identity for the same answer on
 * every render is how a `useEffect` downstream turns into a loop. There is
 * nothing per-call in either of these two states, so there is nothing to
 * allocate.
 */
const IDLE: UseNoteTemplateDetailResult = { template: null, state: 'idle', error: null };
const LOADING: UseNoteTemplateDetailResult = {
  template: null,
  state: 'loading',
  error: null,
};
const MISSING: UseNoteTemplateDetailResult = {
  template: null,
  state: 'missing',
  error: null,
};

/**
 * One template, read by id, for a surface that holds an id and needs the row.
 *
 * The note page is the caller this exists for: `GET /api/notes/{id}` carries
 * `templateId` and a denormalised `templateName`, and NOTHING else about the
 * recipe — not the instructions, not the output format, not the structure. A
 * page that wants to show a reader what their note was actually generated FROM
 * (issue #109) therefore has to read the template itself.
 *
 * ⚠ A NULL ID RESOLVES SYNCHRONOUSLY AND ISSUES NO REQUEST. The `idle` state is
 * the initial state for that case — read in `useState`'s initializer, not
 * applied by an effect — so a note whose template was deleted never renders a
 * skeleton for a row that is never going to arrive.
 */
export function useNoteTemplateDetail(
  templateId: string | null | undefined,
): UseNoteTemplateDetailResult {
  // The initializer, not an effect: see the note above. An effect here would
  // render `idle`-as-`loading` for one frame on every mount with a real id,
  // which is a skeleton flash on the fast path (the template is one indexed
  // row read) and nothing else.
  const [result, setResult] = useState<UseNoteTemplateDetailResult>(() =>
    templateId ? LOADING : IDLE,
  );

  const isMounted = useIsMounted();

  useEffect(() => {
    if (!templateId) {
      setResult(IDLE);
      return;
    }

    // `cancelled` as well as `isMounted()`: the id can change while a request
    // is in flight (`/notes/a` → `/notes/b`), and the component stays mounted
    // through it. Without this the first note's template would win the race
    // and be rendered under the second note's heading.
    let cancelled = false;

    setResult(LOADING);

    void (async () => {
      try {
        const template = await getNoteTemplate(templateId);
        if (cancelled || !isMounted()) return;
        setResult({ template, state: 'loaded', error: null });
      } catch (err) {
        if (cancelled || !isMounted()) return;

        // ⚠ 404 AND 403 ARE BOTH `missing`, NOT `error`. See the type's header:
        // a template the caller cannot read is a fact about the template, not a
        // failure of the request, and the note it generated is unaffected.
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
          setResult(MISSING);
          return;
        }

        setResult({
          template: null,
          state: 'error',
          error:
            err instanceof ApiError && err.message
              ? err.message
              : 'This template could not be loaded',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isMounted, templateId]);

  return result;
}

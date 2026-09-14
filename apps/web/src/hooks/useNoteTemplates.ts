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

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../services/api';
import {
  createNoteTemplate,
  deleteNoteTemplate,
  duplicateNoteTemplate,
  getNoteTemplates,
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
}

export function useNoteTemplates(): UseNoteTemplatesReturn {
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
      const list = await getNoteTemplates();
      if (isMounted()) setTemplates(list.items);
    } catch (err) {
      if (isMounted()) {
        setLoadError(messageFor(err, 'Failed to load your note templates'));
        setTemplates([]);
      }
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
  };
}

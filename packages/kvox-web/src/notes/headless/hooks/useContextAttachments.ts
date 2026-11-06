import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { KvoxApiError, useIsMounted, useKvoxHost } from '../../../core/headless/index.js';
import { getNoteContextAttachmentStatus, uploadNoteContextAttachment } from '../clients/notes.js';
import type { NoteContextAttachment } from '../clients/notes.js';
import {
  MAX_CONTEXT_ATTACHMENTS,
  checkContextAttachmentFile,
  contextAttachmentErrorMessage,
  contextAttachmentIds,
  contextAttachmentLimitMessage,
  contextAttachmentsBlockingReason,
  noteContextAttachmentKind,
  withContextAttachmentMediaType,
} from '../utils/contextAttachments.js';
import type { ContextAttachmentItem } from '../utils/contextAttachments.js';

/**
 * How often an extracting document is asked about. Two seconds, like the document source on
 * the new-note form: a person is watching a spinner.
 */
const DEFAULT_POLL_MS = 2_000;

/**
 * Options of {@link useContextAttachments}.
 *
 * @stability experimental
 */
export interface UseContextAttachmentsOptions {
  /** Attachments the field starts with (a note's own, in the regenerate dialog). */
  initial?: readonly NoteContextAttachment[];
  /** The largest file accepted, when the host knows it; absent leaves size to the server. */
  maxBytes?: number;
  /** How often an extracting document is polled, in milliseconds. Default 2000. */
  pollMs?: number;
}

/**
 * What {@link useContextAttachments} returns.
 *
 * @stability experimental
 */
export interface UseContextAttachmentsResult {
  /** The rows, in the order the model sees them. */
  items: readonly ContextAttachmentItem[];
  /** The ready rows' object ids, in order. */
  ids: string[];
  /** `true` when every row is ready (and when there are none). */
  allReady: boolean;
  /** `true` while any row is uploading or extracting. */
  busy: boolean;
  /** Why submit must wait, or `null`. */
  blockingReason: string | null;
  /** A sentence about files that were not added (over the limit), or `null`. */
  notice: string | null;
  /** How many more files may be added. */
  remaining: number;
  /** Validate and upload files; files over the limit are refused with {@link notice}. */
  addFiles: (files: Iterable<File> | ArrayLike<File>) => void;
  /** Remove one row. */
  remove: (key: string) => void;
  /** Replace every row with these attachments (all ready). */
  reset: (attachments?: readonly NoteContextAttachment[]) => void;
  /** Clear {@link notice}. */
  dismissNotice: () => void;
}

let keySequence = 0;
function nextKey(): string {
  keySequence += 1;
  return `ctx-${keySequence}`;
}

function readyItem(attachment: NoteContextAttachment): ContextAttachmentItem {
  return {
    key: nextKey(),
    filename: attachment.filename,
    kind: attachment.kind,
    objectId: attachment.objectId,
    status: 'ready',
    error: null,
    characters: null,
  };
}

/**
 * The files attached to a note's context (#810): upload, poll an extracting document until it
 * is ready or unreadable, remove, and the ids a create or regenerate body carries.
 *
 * At most `MAX_CONTEXT_ATTACHMENTS` rows. A file of a type the route refuses becomes a
 * `failed` row with the reason (so the user sees which one), and blocks submit until it is
 * removed; files over the limit are not added and {@link UseContextAttachmentsResult.notice}
 * says how many.
 *
 * @param options - See {@link UseContextAttachmentsOptions}.
 * @returns See {@link UseContextAttachmentsResult}.
 * @stability experimental
 */
export function useContextAttachments(options: UseContextAttachmentsOptions = {}): UseContextAttachmentsResult {
  const host = useKvoxHost();
  const isMounted = useIsMounted();
  const { maxBytes = 0, pollMs = DEFAULT_POLL_MS } = options;

  const [items, setItems] = useState<ContextAttachmentItem[]>(() => (options.initial ?? []).map(readyItem));
  const [notice, setNotice] = useState<string | null>(null);
  /** The live rows, for `addFiles` to count against without a stale closure. */
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const patch = useCallback((key: string, change: Partial<ContextAttachmentItem>) => {
    // A row removed while its request was in flight stays removed.
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...change } : item)));
  }, []);

  const upload = useCallback(
    async (key: string, file: File) => {
      try {
        const uploaded = await uploadNoteContextAttachment(host, withContextAttachmentMediaType(file));
        if (!isMounted()) return;
        patch(key, {
          objectId: uploaded.objectId,
          kind: uploaded.kind,
          filename: uploaded.filename || file.name,
          status: uploaded.status === 'ready' ? 'ready' : 'extracting',
        });
      } catch (err) {
        if (!isMounted()) return;
        patch(key, {
          status: 'failed',
          error:
            contextAttachmentErrorMessage(err) ??
            (err instanceof KvoxApiError ? err.message : 'This file could not be uploaded.'),
        });
      }
    },
    [host, isMounted, patch],
  );

  const addFiles = useCallback(
    (files: Iterable<File> | ArrayLike<File>) => {
      const chosen = Array.from(files as ArrayLike<File>);
      if (chosen.length === 0) return;
      const room = Math.max(0, MAX_CONTEXT_ATTACHMENTS - itemsRef.current.length);
      const accepted = chosen.slice(0, room);
      const refused = chosen.length - accepted.length;
      setNotice(refused > 0 ? contextAttachmentLimitMessage(refused) : null);

      const added: ContextAttachmentItem[] = [];
      const toUpload: [string, File][] = [];
      for (const file of accepted) {
        const key = nextKey();
        const problem = checkContextAttachmentFile(file, maxBytes);
        added.push({
          key,
          filename: file.name,
          kind: noteContextAttachmentKind(file),
          objectId: null,
          status: problem ? 'failed' : 'uploading',
          error: problem,
          characters: null,
        });
        if (!problem) toUpload.push([key, file]);
      }
      const next = [...itemsRef.current, ...added];
      itemsRef.current = next;
      setItems(next);
      for (const [key, file] of toUpload) void upload(key, file);
    },
    [maxBytes, upload],
  );

  const remove = useCallback((key: string) => {
    setItems((current) => {
      const next = current.filter((item) => item.key !== key);
      itemsRef.current = next;
      return next;
    });
    setNotice(null);
  }, []);

  const reset = useCallback((attachments: readonly NoteContextAttachment[] = []) => {
    const next = attachments.map(readyItem);
    itemsRef.current = next;
    setItems(next);
    setNotice(null);
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  // --- Poll the extracting documents ----------------------------------------
  // Keyed on the SET of extracting object ids, so a row settling restarts the poll over the
  // ones still waiting rather than asking about it again.
  const extractingKey = items
    .filter((item) => item.status === 'extracting' && item.objectId)
    .map((item) => `${item.key}:${item.objectId}`)
    .join(',');

  useEffect(() => {
    if (!extractingKey) return;
    const targets = extractingKey.split(',').map((pair) => {
      const [key, objectId] = pair.split(':');
      return { key, objectId };
    });
    let cancelled = false;

    const tick = async () => {
      await Promise.all(
        targets.map(async ({ key, objectId }) => {
          try {
            const next = await getNoteContextAttachmentStatus(host, objectId);
            if (cancelled || !isMounted()) return;
            if (next.status === 'ready') {
              patch(key, { status: 'ready', characters: next.characters });
            } else if (next.status === 'unextractable') {
              patch(key, {
                status: 'failed',
                error: next.message ?? 'No text could be read from this document, so it cannot be attached.',
              });
            }
          } catch {
            // A failed poll is left alone: the job is still running and the next tick asks again.
          }
        }),
      );
    };

    const timer = setInterval(() => void tick(), pollMs);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [extractingKey, host, isMounted, patch, pollMs]);

  return useMemo(() => {
    const blockingReason = contextAttachmentsBlockingReason(items);
    return {
      items,
      ids: contextAttachmentIds(items),
      allReady: items.every((item) => item.status === 'ready'),
      busy: items.some((item) => item.status === 'uploading' || item.status === 'extracting'),
      blockingReason,
      notice,
      remaining: Math.max(0, MAX_CONTEXT_ATTACHMENTS - items.length),
      addFiles,
      remove,
      reset,
      dismissNotice,
    };
  }, [addFiles, dismissNotice, items, notice, remove, reset]);
}

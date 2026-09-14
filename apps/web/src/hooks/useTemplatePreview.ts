/**
 * One template preview: request it, stream it, tear it down — issue #56,
 * epic #45.
 *
 * =============================================================================
 * THIS HOOK OWNS A SOCKET, WHICH IS WHY IT EXISTS AT ALL
 * =============================================================================
 *
 * Everything else on the templates page is a form. This is the one piece of it
 * holding a resource the browser will not reclaim on its own, and the failure
 * mode it guards against is invisible: a user who starts a preview and
 * navigates away leaves a `fetch` reading an event stream that never ends,
 * against a component that no longer exists, retrying on backoff for the life
 * of the tab. Nothing renders wrong; the tab simply accumulates one dead
 * connection per abandoned preview.
 *
 * So THREE things close the connection, and all three are required:
 *
 *   1. A terminal frame (`done` / `error`), closed inside
 *      `connectNoteGenerationStream` before the callback runs.
 *   2. Starting a NEW preview, which closes the previous one first — a user
 *      adjusting instructions and pressing Preview again must not end up with
 *      two streams writing into one panel.
 *   3. UNMOUNT. The effect cleanup below, which is what
 *      `UserNoteTemplatesPage.test.tsx` asserts with a fake connection.
 *
 * The connection is held in a REF rather than in state: it is not rendered,
 * and putting it in state would re-render the panel on every attach purely to
 * store a handle.
 *
 * =============================================================================
 * THE REQUEST BODY IS BUILT BY THE CALLER, FROM THE LIVE FORM
 * =============================================================================
 *
 * `start` takes a fully-formed `PreviewNoteTemplateInput` and sends it
 * unchanged. It deliberately does NOT reach for a saved template, a last-known
 * draft or a memoised copy: "what is tested is what is on screen" is issue
 * #56's central behaviour, and a hook that assembled the body from its own
 * state would be a second, lagging source for it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../services/api';
import { previewNoteTemplate } from '../services/noteTemplates';
import type {
  NoteTemplatePreview,
  PreviewNoteTemplateInput,
} from '../services/noteTemplates';
import {
  connectNoteGenerationStream,
  describeStreamError,
  type SseConnection,
} from '../services/noteGenerationStream';
import { useIsMounted } from './useIsMounted';

/**
 * Where one preview has got to.
 *
 * `'streaming'` is distinct from `'requesting'` because they fail differently
 * and the user can do different things about each: a failed REQUEST (no key, a
 * model the deployment withdrew, a prompt over budget) is a form problem they
 * can fix and retry immediately; a failed STREAM has already been billed.
 */
export type PreviewStatus = 'idle' | 'requesting' | 'streaming' | 'done' | 'error';

export interface UseTemplatePreviewReturn {
  status: PreviewStatus;
  /** The markdown received so far. Rendered live, not only when complete. */
  content: string;
  /** The 202 body — which model, whose account, when it expires. `null` until requested. */
  preview: NoteTemplatePreview | null;
  /** Why it failed, in a sentence. Rendered inline; the form stays editable. */
  error: string | null;
  /** True from the moment Preview is pressed until a terminal frame or a failure. */
  isRunning: boolean;
  start: (input: PreviewNoteTemplateInput) => Promise<void>;
  /** Abandon a run and drop its output. Also what "close the panel" calls. */
  reset: () => void;
}

/**
 * A rejection from `POST /preview`, as a sentence a user can act on.
 *
 * The API's own statuses are specific and so are these: 409 means the
 * DEPLOYMENT or the key is not ready (not a retry), 400 means the request the
 * form just built cannot be satisfied (a retry after an edit), 404 means the
 * chosen source is gone.
 */
function requestMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      return (
        err.message ||
        'AI is not ready: either this deployment has not enabled it, or your account has no API key saved.'
      );
    }
    if (err.status === 404) {
      return 'That source is no longer available to you. Pick another and try again.';
    }
    if (err.status === 400) {
      return err.message || 'This template could not be previewed against that source.';
    }
    return err.message || 'The preview could not be started.';
  }
  return 'The preview could not be started.';
}

export function useTemplatePreview(): UseTemplatePreviewReturn {
  const [status, setStatus] = useState<PreviewStatus>('idle');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState<NoteTemplatePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isMounted = useIsMounted();
  const connectionRef = useRef<SseConnection | null>(null);

  /** Close whatever is open, and forget it. Safe to call at any point. */
  const closeConnection = useCallback(() => {
    connectionRef.current?.close();
    connectionRef.current = null;
  }, []);

  // ⚠ THE LEAK GUARD. Registered once, with no dependencies, so it cannot be
  // torn down and re-registered by a re-render mid-stream — which would close
  // the live connection every time the user typed a character into the form.
  useEffect(() => closeConnection, [closeConnection]);

  const reset = useCallback(() => {
    closeConnection();
    setStatus('idle');
    setContent('');
    setPreview(null);
    setError(null);
  }, [closeConnection]);

  const start = useCallback(
    async (input: PreviewNoteTemplateInput) => {
      // A second Preview replaces the first rather than racing it.
      closeConnection();
      setStatus('requesting');
      setContent('');
      setPreview(null);
      setError(null);

      let queued: NoteTemplatePreview;
      try {
        queued = await previewNoteTemplate(input);
      } catch (err) {
        if (isMounted()) {
          setError(requestMessage(err));
          setStatus('error');
        }
        return;
      }

      // The component went away while the 202 was in flight. Attaching now
      // would open a stream nothing will ever close.
      if (!isMounted()) return;

      setPreview(queued);
      setStatus('streaming');

      connectionRef.current = connectNoteGenerationStream(queued.generationId, {
        onContent: (next) => {
          if (isMounted()) setContent(next);
        },
        onDone: () => {
          connectionRef.current = null;
          if (isMounted()) setStatus('done');
        },
        onError: (streamError) => {
          connectionRef.current = null;
          if (isMounted()) {
            setError(describeStreamError(streamError));
            // `'error'` even when text arrived first: a partial sample is not
            // a result, and leaving the status at `'streaming'` would spin a
            // progress indicator against a connection that is over.
            setStatus('error');
          }
        },
      });
    },
    [closeConnection, isMounted],
  );

  return {
    status,
    content,
    preview,
    error,
    isRunning: status === 'requesting' || status === 'streaming',
    start,
    reset,
  };
}

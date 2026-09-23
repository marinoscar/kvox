import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One copy-to-clipboard primitive for the whole app — issue #308.
 *
 * Generalises the pattern `NoteConflictDialog` grew on its own: a three-state
 * result the UI can render (`idle` → `done` | `failed` → `idle`) and a copy
 * function that NEVER throws, so a caller cannot forget the `catch` and turn
 * a refused clipboard into an unhandled rejection.
 *
 * ⚠ A FAILED COPY IS NEVER REPORTED AS A SUCCESS. `navigator.clipboard` only
 * exists in a secure context (a plain-HTTP self-hosted deployment is not one),
 * so outside it this falls back to the legacy `execCommand('copy')` on an
 * off-screen textarea — and reports `failed` when that returns `false`, which
 * is how a browser says it declined.
 */
export type CopyState = 'idle' | 'done' | 'failed';

export interface UseCopyToClipboardResult {
  state: CopyState;
  copy: (text: string) => Promise<boolean>;
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  // Off-screen rather than `display: none` — a hidden element cannot hold a
  // selection, and a selection is what `execCommand('copy')` copies.
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';

  const previouslyFocused = document.activeElement as HTMLElement | null;
  document.body.appendChild(textarea);
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
    previouslyFocused?.focus?.();
  }
}

export function useCopyToClipboard(resetMs = 2000): UseCopyToClipboardResult {
  const [state, setState] = useState<CopyState>('idle');
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, []);

  const settle = useCallback(
    (next: CopyState) => {
      if (!mounted.current) return;
      setState(next);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        if (mounted.current) setState('idle');
      }, resetMs);
    },
    [resetMs],
  );

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      let ok = false;
      try {
        if (
          typeof window !== 'undefined' &&
          window.isSecureContext &&
          typeof navigator !== 'undefined' &&
          navigator.clipboard
        ) {
          await navigator.clipboard.writeText(text);
          ok = true;
        } else {
          ok = legacyCopy(text);
        }
      } catch {
        ok = false;
      }
      settle(ok ? 'done' : 'failed');
      return ok;
    },
    [settle],
  );

  return { state, copy };
}

export default useCopyToClipboard;

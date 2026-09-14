/**
 * "You have unsaved changes" — issue #58, epic #45.
 *
 * =============================================================================
 * WHY THIS EXISTS AT ALL: THERE IS NO AUTOSAVE, DELIBERATELY
 * =============================================================================
 *
 * Every note save is a version (#48), so an autosaving editor would turn a
 * five-minute edit into thirty history rows and make the history useless for
 * the one thing it is for — showing a person what changed and letting them go
 * back. #58 rejects autosave for that reason and accepts the risk it would
 * otherwise have covered: a user can navigate away from unsaved text.
 *
 * This hook is how that risk is covered instead. It is the WHOLE mitigation,
 * which is why it lives in one file with its own name rather than as three
 * lines inside the page.
 *
 * =============================================================================
 * ⚠ `beforeunload` ONLY — NOT `useBlocker`
 * =============================================================================
 *
 * `react-router`'s `useBlocker` covers in-app navigation, and it is deliberately
 * not used: it throws outside a DATA router, and this application mounts a
 * `BrowserRouter`/`MemoryRouter` (see `App.tsx` and `__tests__/utils/test-utils`).
 * A hook that threw in every test and in the real app is not a guard.
 *
 * So the two halves of "navigating away" are covered separately, and honestly:
 *
 *   - LEAVING THE TAB (reload, close, a link to another origin) is this hook —
 *     the browser's own confirmation, which no application can style or
 *     replace.
 *   - LEAVING THE PAGE INSIDE THE APP is the caller's own affordance:
 *     `NotePage` routes its History link and its back navigation through a
 *     confirmation dialog while the editor is dirty. That is a real guard the
 *     user can read, rather than a browser dialog they cannot.
 *
 * Neither half can catch a browser Back button press inside a non-data router,
 * and the page says nothing that implies it can.
 */

import { useEffect } from 'react';

/**
 * Ask the browser to confirm before the tab leaves, while `enabled`.
 *
 * @param enabled whether there is unsaved work right now. Passing `false`
 *        removes the listener — a guard that stayed attached after a save
 *        would prompt a user protecting nothing, which is how people learn to
 *        dismiss the prompt without reading it.
 */
export function useUnsavedChangesWarning(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Assigning `returnValue` as well as calling `preventDefault` is what
      // older browsers actually honour; the string is never shown by anything
      // current, which is why there is no message to translate. The identical
      // pair `useTranscriptOperations` uses for its own pending-save guard.
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', guard);

    return () => window.removeEventListener('beforeunload', guard);
  }, [enabled]);
}

export default useUnsavedChangesWarning;

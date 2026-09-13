import { useCallback } from 'react';
import { Button, IconButton, Snackbar } from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import { useRegisterSW } from 'virtual:pwa-register/react';

/**
 * The "a new version is available" prompt, and the thing that REGISTERS the
 * service worker at all.
 *
 * Issue #219, epic #215. Issue #218 shipped the worker with
 * `registerType: 'prompt'` and `injectRegister: 'auto'`, which is a working
 * registration with no user-visible half: a new worker installs, moves to
 * `waiting`, and stays there. Because that worker PRECACHES THE APP SHELL, the
 * browser keeps serving the shell of whichever revision installed first — so a
 * deploy reaches nobody until every tab of the origin is closed, which on a
 * pinned-tab enterprise app can be weeks. This component is the missing half:
 * it surfaces the waiting worker and posts the `SKIP_WAITING` message that
 * `src/sw.ts` already listens for.
 *
 * =============================================================================
 * WHY NOT `registerType: 'autoUpdate'`, WHICH WOULD DELETE THIS FILE
 * =============================================================================
 *
 * `autoUpdate` activates the new worker the moment it installs and reloads the
 * page underneath the user. In a form-heavy application that is not a
 * convenience, it is a DATA-LOSS BUG: every unsaved field in the settings
 * pages, the JSON in the advanced editor, a half-written allowlist entry — all
 * of it is discarded, mid-keystroke, by a deploy the user had no part in. The
 * user cannot retry what they cannot see, and the failure is invisible in
 * aggregate because nothing errors.
 *
 * `prompt` costs exactly one click and makes the reload the user's decision,
 * which is why `pwa/service-worker.ts` pins it and why its test asserts it.
 * Do not "simplify" this away.
 *
 * =============================================================================
 * THIS COMPONENT OWNS REGISTRATION
 * =============================================================================
 *
 * `useRegisterSW` registers the worker itself, which is why
 * `pwa/service-worker.ts` now sets `injectRegister: null` — with `'auto'` the
 * injected `registerSW.js` would register it a second time, from a script the
 * React tree cannot observe. One registration, in one place, whose state is
 * the state this component renders.
 *
 * It follows that this must be mounted on EVERY route, including `/login`: an
 * unauthenticated user sitting on a stale shell has the same problem, and the
 * worker is also what makes notifications possible on Android (see `src/sw.ts`)
 * long before any page asks for permission. See `App.tsx` for the mount point.
 *
 * =============================================================================
 * IT RENDERS NOTHING IN THE DEFAULT STATE
 * =============================================================================
 *
 * No waiting worker and no fresh install means `null` — not a hidden element,
 * not an empty `Snackbar`. A normal page load is pixel-identical to one without
 * this component, which is what keeps the visual-regression suite honest.
 *
 * The one moment anything appears unprompted is the VERY FIRST visit in a
 * browser profile, where `offlineReady` fires as the worker installs and shows
 * a four-second confirmation. That is the intended behaviour and it cannot
 * reach the pixel suite: `apps/web/visual/vite.config.ts` deliberately omits
 * `VitePWA` and its harness mounts its own tree rather than `App.tsx`, so
 * neither the worker nor this component exists there.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW();

  const dismiss = useCallback(() => {
    setNeedRefresh(false);
    setOfflineReady(false);
  }, [setNeedRefresh, setOfflineReady]);

  const reload = useCallback(() => {
    // This posts `SKIP_WAITING` to the waiting worker; `src/sw.ts` answers it
    // with `self.skipWaiting()`, and the hook's own `controlling` listener
    // reloads the page once the new worker has taken over. Not awaited: the
    // document is replaced out from under the promise.
    //
    // The `true` is the documented "reload the page" argument, kept because it
    // states the intent at the call site — but note that vite-plugin-pwa has
    // IGNORED this parameter since 0.13.2 (it is `_reloadPage` in the source).
    // The reload is wired by the hook regardless, so do not read this argument
    // as the thing that causes it.
    void updateServiceWorker(true);
  }, [updateServiceWorker]);

  // The update always wins if both are somehow true: "there is a newer version
  // of this app" is actionable, "the shell is cached" is a note.
  if (!needRefresh && !offlineReady) {
    return null;
  }

  return (
    <Snackbar
      open
      // The update prompt does NOT auto-hide: it is the only route by which an
      // update reaches a long-lived tab, and a message that vanishes after five
      // seconds is one the user is entitled to miss. The offline confirmation
      // does auto-hide — it is an FYI about something that already succeeded.
      autoHideDuration={needRefresh ? null : 4000}
      onClose={(_event, reason) => {
        // Click-away must not dismiss the update prompt; the user is expected
        // to keep working in the page behind it and decide when to reload.
        if (reason === 'clickaway') return;
        dismiss();
      }}
      message={
        needRefresh ? 'A new version is available' : 'Ready to work offline'
      }
      // Clears the fixed `BottomNav`, which exists only below `sm` — the same
      // breakpoint `<main>`'s `pb: { xs: 10, sm: 3 }` in `Layout.tsx` clears it
      // at. This is a static responsive STYLE, not a sixth `useMediaQuery`
      // mount gate (see `Layout.tsx`'s five coupled gates and
      // `NotificationBell.tsx`'s note on not adding to them), so it changes
      // nothing about what is in the tree.
      sx={{ bottom: { xs: 72, sm: 24 } }}
      action={
        <>
          {needRefresh && (
            <Button color="secondary" size="small" onClick={reload}>
              Reload
            </Button>
          )}
          <IconButton
            size="small"
            aria-label="Dismiss update notice"
            color="inherit"
            onClick={dismiss}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </>
      }
    />
  );
}

export default UpdatePrompt;

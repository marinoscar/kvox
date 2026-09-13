import { useCallback, useEffect, useState } from 'react';
import { Button, IconButton, Snackbar } from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import { APP_NAME } from '@app/shared';

/**
 * The "install this app" offer.
 *
 * Issue #219, epic #215. Installing is not a vanity feature here: on iOS,
 * adding the app to the Home Screen is the ONLY thing that unlocks the Web
 * Push permission prompt at all, and on Android an installed app is what gives
 * notifications a launcher icon to come from. So the epic needs an install
 * path, and a path the user never sees is not one.
 *
 * =============================================================================
 * WHAT THIS COMPONENT COVERS, AND WHAT IT DELIBERATELY DOES NOT
 * =============================================================================
 *
 * It covers the browsers that FIRE `beforeinstallprompt` — Chrome, Edge and
 * Chromium-based Android browsers. There the browser hands the page a deferred
 * event, and calling `prompt()` on it opens the real, native install dialog.
 *
 * IOS/SAFARI IS OUT OF SCOPE ON PURPOSE, AND ITS ABSENCE IS NOT A BUG.
 * Safari never fires `beforeinstallprompt` and exposes no API to trigger
 * installation, so nothing this component could do would help there: the user
 * has to tap Share → Add to Home Screen themselves. That walkthrough — a
 * platform-detected, illustrated set of instructions rather than a button — is
 * ISSUE #231, and it belongs in its own component because it shares no code
 * with this one. Do not "fix" the omission by adding a fake install button for
 * iOS; a button that cannot install anything is worse than no button.
 *
 * =============================================================================
 * IT RENDERS NOTHING IN THE DEFAULT STATE
 * =============================================================================
 *
 * Until the browser volunteers the event, this is `null`. It is also `null`
 * when the app is ALREADY RUNNING INSTALLED (`display-mode: standalone`, or
 * `navigator.standalone` on iOS) — offering to install an app from inside that
 * same installed app is the kind of detail that makes a product feel unfinished
 * — and `null` once the user has said no.
 */

/**
 * The non-standard event Chromium fires when the app meets its installability
 * criteria. It is not in `lib.dom`, so it is declared here rather than widened
 * with an `any` at the call site.
 */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt: () => Promise<void>;
}

/** iOS Safari's pre-standard "am I on the Home Screen?" flag. */
interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

/**
 * Follows `ThemeContext`'s `theme_mode` naming for the same reason: these keys
 * share one origin-wide namespace, so they read as one set or they read as
 * accidents.
 */
const INSTALL_DISMISSED_KEY = 'pwa_install_dismissed';

/**
 * EVERY `localStorage` ACCESS IN THIS FILE IS WRAPPED, and that is not
 * defensive padding. `localStorage` is not merely empty in Safari's private
 * mode and under a "block third-party cookies" policy in an iframe — the
 * getter itself THROWS (`SecurityError`) on property access. An unguarded read
 * during render would take the whole app down with a white screen, for a
 * feature whose entire job is a dismissible suggestion.
 *
 * The failure mode of the fallback is that the offer reappears on the next
 * visit, which is the correct thing to be wrong about.
 */
function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(INSTALL_DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(INSTALL_DISMISSED_KEY, 'true');
  } catch {
    // Nothing to recover: the dismissal still holds for this page's lifetime
    // through React state, it just will not survive a reload.
  }
}

/**
 * Whether the app is already running as an installed app.
 *
 * Both checks are needed and neither is redundant: `display-mode: standalone`
 * is the standard signal every Chromium browser answers, and
 * `navigator.standalone` is the pre-standard one iOS Safari answers instead.
 * `matchMedia` is called defensively — some embedded webviews do not implement
 * it, and a `TypeError` here would be a crash rather than a missing suggestion.
 */
function isRunningInstalled(): boolean {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) {
      return true;
    }
  } catch {
    // Fall through to the iOS flag.
  }
  return (window.navigator as NavigatorWithStandalone).standalone === true;
}

export function InstallPrompt() {
  /**
   * The captured event. Holding it is the whole trick: the browser only offers
   * it once, and `prompt()` may only be called on it in response to the user's
   * gesture — which has not happened yet at capture time.
   */
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);
  const [installed, setInstalled] = useState<boolean>(isRunningInstalled);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      // Suppresses Chromium's own mini-infobar, which appears at a moment of
      // the browser's choosing, over the app's content, with no relationship
      // to what the user is doing. Preventing it is what earns the right to
      // show the offer below instead — and it is required before the event can
      // be deferred at all.
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      // Fires when the install completes THROUGH ANY ROUTE — including the
      // browser's own omnibox affordance, which this component knows nothing
      // about. Without this, an app installed from the address bar leaves the
      // "install" offer sitting on screen in the tab that is still open.
      setInstallEvent(null);
      setInstalled(true);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const install = useCallback(() => {
    if (!installEvent) return;
    // Cleared FIRST, unconditionally: the deferred event is single-use, so a
    // second `prompt()` on it rejects. Dropping the reference here also closes
    // this snackbar the moment the browser's own dialog takes over, which is
    // the only sensible thing for it to do while a native modal is up.
    setInstallEvent(null);
    void installEvent.prompt().catch(() => {
      // The browser declined to show the dialog (already installed in another
      // window, gesture no longer trusted). There is nothing to tell the user
      // that they can act on, and the offer is gone from this page either way.
    });
  }, [installEvent]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    setInstallEvent(null);
    // Persisted, and permanently. Re-asking on every visit is how an install
    // prompt becomes the thing users learn to dismiss without reading. The user
    // is not stranded by this: the browser keeps its own install affordance in
    // the omnibox / menu, which is where someone who changes their mind looks.
    writeDismissed();
  }, []);

  if (installed || dismissed || !installEvent) {
    return null;
  }

  return (
    <Snackbar
      open
      // No auto-hide. This is an offer, not a status message: it should be
      // answered, not outwaited. `clickaway` is ignored below for the same
      // reason — typing in the page behind it is not an answer.
      onClose={(_event, reason) => {
        if (reason === 'clickaway') return;
        dismiss();
      }}
      message={`Install ${APP_NAME} for faster access and notifications`}
      // Matches `UpdatePrompt`'s offset for the same reason — it clears the
      // fixed `BottomNav`, which exists only below `sm`. A static responsive
      // style, not a `useMediaQuery` mount gate.
      //
      // Both prompts anchor bottom-left, so in the rare moment they are both
      // open they overlap. Left alone deliberately: staggering them would mean
      // one component knowing about the other's state, and the overlap needs a
      // deploy to land in the same seconds as a first-time install offer.
      sx={{ bottom: { xs: 72, sm: 24 } }}
      action={
        <>
          <Button color="secondary" size="small" onClick={install}>
            Install
          </Button>
          <IconButton
            size="small"
            aria-label="Dismiss install prompt"
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

export default InstallPrompt;

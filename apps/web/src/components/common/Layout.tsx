import { BrandLockup } from '@marinoscar/kvox-web/brand';
import { MaintenanceBanner } from '@marinoscar/platform-web/host/ui';
import {
  NotificationBell,
  NotificationPermissionBanner,
} from '@marinoscar/platform-web/notifications/ui';
import { usePushSubscriptionSync } from '@marinoscar/platform-web/notifications/headless';
// Onboarding (#276/#277, epic #271; the platform's since #481, epic #478). The provider, the
// banner and the welcome dialog mount together, HERE, for the reason the banner documents: the
// shell is the one place that exists exactly once per authenticated session, and it is
// deliberately not `App.tsx` — every endpoint the provider calls is authenticated, so mounting it
// above `RequireAuth` would buy a guaranteed 401 on `/login` and `/auth/callback`.
import { OnboardingProvider } from '@marinoscar/platform-web/onboarding/headless';
import { GettingStartedMenuItem, WelcomeDialog } from '@marinoscar/platform-web/onboarding/ui';
import {
  ShellAppBar,
  ShellBottomNav,
  ShellLayout,
  ShellUserMenu,
} from '@marinoscar/platform-web/shell/ui';
import { APP_NAME } from '@app/shared';
import { KVOX_BOTTOM_BAR_NAVIGATION, KVOX_NAVIGATION } from '../../config/shell';
import { OnboardingBanner } from '../onboarding/OnboardingBanner';
import { adminWelcomePane, userWelcomePane } from '../onboarding/kvoxWelcomePanes';

/** The mark and the wordmark: one clickable lockup (the AppBar sends it home). */
const BRAND = <BrandLockup />;

/**
 * The app shell: a thin binding of the packaged `ShellLayout`
 * (`@marinoscar/platform-web/shell/ui`, issue #484, epic #478).
 *
 * The package owns the chrome and, with it, the FIVE COUPLED BREAKPOINT GATES
 * (`docs/specs/settings-ui.md`, "Breakpoint gates"): the rail's `up('sm')`
 * mount, the bottom bar's `down('sm')` self-gate, `<main>`'s
 * `pb: { xs: 10, sm: 3 }`, the settings hub's `isCompactWindow` and the
 * AppBar's `isCompactWindow`. NOTHING IN THIS FILE READS A BREAKPOINT, and
 * nothing here may: a sixth read would let the chrome disagree with the gate
 * that decides which treatment mounts (`__tests__/config/breakpointGates.test.ts`
 * fails the build if one appears).
 *
 * What this file contributes is the app's slots:
 *   - the navigation (`config/shell.ts`) and the brand;
 *   - the AppBar's `actions` (the notification bell, mounted in both treatments)
 *     and its user menu with the platform's "Getting started" row;
 *   - the bottom bar, bound to the NON-PINNED destinations so the phone bar stays
 *     Home · Transcripts · Notes · Knowledge (see `KVOX_BOTTOM_BAR_NAVIGATION`);
 *   - the `banners` above the page (maintenance, onboarding, notification
 *     permission), each of which renders nothing on an ordinary day;
 *   - the `overlays`: the platform's one-time welcome dialog, with this app's panes.
 */
export function Layout() {
  // Issue #365. Mounted HERE, once, because the shell exists exactly for an
  // authenticated user: auto-prompts for notification permission when push is
  // on, and keeps this device's push subscription registered on every load.
  const pushSync = usePushSubscriptionSync();

  return (
    /* ONE MOUNT POINT FOR THE WHOLE SHELL (#276). Four surfaces in epic #271
       need the same answer — the banner, the admin setup page (#278), the
       getting-started page (#279) and the welcome dialog (#280) — and a
       provider per surface would reissue the same two reads on every hop
       between the setup page and the pages it links to, while giving four
       components four chances to disagree about whether setup is finished.

       It wraps the WHOLE shell rather than just `<main>` so that the routed
       pages are inside it: `/admin/settings/setup` and `/settings/getting-started`
       render the same state the banner reads, and a second provider around the
       page would be a second copy of it. */
    <OnboardingProvider appName={APP_NAME}>
      <ShellLayout
        navigation={KVOX_NAVIGATION}
        appBar={
          <ShellAppBar
            navigation={KVOX_NAVIGATION}
            brand={BRAND}
            // The notification centre (#127, epic #109; the platform's since #470) —
            // mounted in BOTH treatments, including the compact drill-down, where it is
            // the only way into the centre. Renders NOTHING when no
            // `NotificationProvider` is mounted.
            actions={<NotificationBell />}
            userMenu={
              <ShellUserMenu
                navigation={KVOX_NAVIGATION}
                items={(close) => <GettingStartedMenuItem onDone={close} />}
              />
            }
          />
        }
        bottomNav={<ShellBottomNav navigation={KVOX_BOTTOM_BAR_NAVIGATION} />}
        banners={
          <>
            {/* Issue #258, epic #254. Above the page rather than inside any one
                of them, because "this deployment is deliberately out of service"
                is a property of the shell, not of whatever the operator happens
                to be looking at. It renders NOTHING — no element, no spacing —
                for anyone without `system_settings:read` and whenever no window
                is open, which is every viewer on every ordinary day. */}
            <MaintenanceBanner />
            {/* Issue #277, epic #271. "What is left to set up" is a property of
                the session rather than of whatever page happens to be open, and a
                checklist you abandon on step 2 has to be visible from the page you
                abandoned it on. IT IS HERE AND NOT ON `HomePage`: that page's test
                asserts an exact request set and renders the page WITHOUT this
                layout. Renders NOTHING while loading, for a read that failed, once
                every required step is satisfied, and for anyone who has put the
                checklist away. */}
            <OnboardingBanner />
            {/* Issue #365. Fed by the shell's single `usePushSubscriptionSync`
                mount above; renders nothing unless this device still needs to
                allow (or unblock, or install for) notifications. */}
            <NotificationPermissionBanner
              config={pushSync.config}
              capability={pushSync.capability}
              onRequestPermission={() => void pushSync.requestPermission()}
              isRequestingPermission={pushSync.isRequestingPermission}
            />
          </>
        }
        overlays={
          /* The platform's one-time welcome (#481), with this app's three panes in its two
             body slots. Portalled, so its position in this tree is about LIFETIME rather
             than layout: it belongs to the session, opens only while
             `onboarding.welcomeSeenAt` is unset, and every way out (the buttons, Escape, the
             backdrop) writes it. It never reopens by itself afterwards, including once the
             step registry grows a step. */
          <WelcomeDialog slots={{ userPane: userWelcomePane, adminPane: adminWelcomePane }} />
        }
      />
    </OnboardingProvider>
  );
}

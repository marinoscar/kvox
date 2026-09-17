import { Box, useMediaQuery, useTheme } from '@mui/material';
import { Outlet } from 'react-router-dom';
import { AppBar } from '../navigation/AppBar';
import { MaintenanceBanner } from './MaintenanceBanner';
import { NotificationPermissionBanner } from '../notifications/NotificationPermissionBanner';
// Onboarding (#276/#277, epic #271). The provider and the banner mount
// together, HERE, for the reason each of them documents in its own header: the
// shell is the one place that exists exactly once per authenticated session,
// and it is deliberately not `App.tsx` — every endpoint the provider calls is
// `@Auth()`-guarded, so mounting it above `ProtectedRoute` would buy a
// guaranteed 401 on `/login`, `/auth/callback` and `/activate`.
import { OnboardingProvider } from '../../contexts/OnboardingContext';
import { OnboardingBanner } from '../onboarding/OnboardingBanner';
import { usePushSubscriptionSync } from '../../hooks/usePushSubscriptionSync';
import { NavigationRail } from '../navigation/NavigationRail';
import { BottomNav } from '../navigation/BottomNav';

/**
 * The app shell — two navigation treatments, one per size class.
 *
 * Issue #55, epic #51. The `Sidebar` drawer this used to mount is gone from
 * every breakpoint:
 *
 *   compact (< sm)  →  bottom bar only. No drawer, no hamburger, and so NO
 *                      DRAWER STATE TO MANAGE — which is why this component no
 *                      longer holds any, and why the `setTimeout` that used to
 *                      sequence navigation behind the drawer's close animation
 *                      is gone with it.
 *   medium  (sm–lg) →  a permanent collapsed rail (56px). Always visible, so
 *                      navigating costs zero taps instead of one.
 *   expanded (≥ lg) →  the same rail, expanded to 220px with labelled rows.
 *
 * The chrome is chosen by MOUNTING, not by rendering-then-hiding: exactly one
 * navigation surface exists in the tree at any width, so a resize across `sm`
 * swaps it rather than briefly showing two.
 */
export function Layout() {
  const theme = useTheme();
  // 600px, NOT 900px. This is Material 3's compact/medium window-class
  // boundary — compact < 600dp, medium 600–840dp — and M3 is explicit that a
  // rail is the correct chrome from medium upward. Gating at MUI's `md`
  // (900px) would hand the PHONE treatment to every 600–899px device: tablets
  // in portrait (iPad 768px, iPad Pro 11" 834px), foldables unfolded, and
  // phones in landscape.
  //
  // ⚠️ FIVE GATES ARE COUPLED AND MUST MOVE TOGETHER. Moving the rail alone
  // renders two navigation surfaces, or none, in the gap:
  //   1. this `showRail`                    — the rail itself
  //   2. `BottomNav`'s `down('sm')`         — the EXACT complement
  //   3. `<main>`'s `pb` below              — clears the fixed bottom bar, and
  //                                           so is only needed where the bar
  //                                           exists
  // Epic #90 adds two more members to the set, both `down('sm')` and both
  // about the SETTINGS surface rather than the shell's own chrome:
  //   4. `settings/SettingsHub`'s           — drill-down list below it, card
  //      `isCompactWindow` (#93)              grid at and above it
  //   5. the AppBar's compact treatment     — back arrow + resolved page title
  //      (#95)                                on `/admin/*` and `/settings/*`
  // (4) and (5) are coupled to EACH OTHER as tightly as (1)–(3) are: the hub is
  // the page body and the AppBar is the header directly above it, so a
  // disagreement between them puts a back-arrow drill-down header over a card
  // grid, or a full toolbar over a list with no way back up. They are tied to
  // (1)–(3) as well, because "there is no rail here" is exactly what makes the
  // hub itself the navigation below `sm`.
  //
  // This comment is the invariant's only enforcement; there is deliberately no
  // shared constant, because a constant would let (3) drift while still
  // compiling. If you change one number here, change all five.
  const showRail = useMediaQuery(theme.breakpoints.up('sm'));

  // Issue #365. Mounted HERE, once, because the shell exists exactly for an
  // authenticated user: auto-prompts for notification permission when push is
  // on, and keeps this device's push subscription registered on every load.
  const pushSync = usePushSubscriptionSync();

  return (
    /* ONE MOUNT POINT FOR THE WHOLE SHELL (#276). Four surfaces in epic #271
       need the same answer — this banner, the admin setup page (#278), the
       getting-started page (#279) and the welcome dialog (#280) — and a
       provider per surface would reissue the same two reads on every hop
       between the setup page and the pages it links to, while giving four
       components four chances to disagree about whether setup is finished.

       It wraps the WHOLE shell rather than just `<main>` so that `<Outlet />`'s
       pages are inside it: `/admin/settings/setup` and `/settings/getting-started`
       render the same state this banner reads, and a second provider around the
       page would be a second copy of it. */
    <OnboardingProvider>
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          // The shell is the ONLY owner of viewport height — pages must not nest
          // their own 100vh inside it, or the document is always at least
          // 100vh + AppBar tall and scrolls even when the content fits. `100dvh`
          // tracks mobile browser chrome; plain `100vh` measures against the
          // LARGEST viewport, so a collapsing URL bar adds jitter. The `100vh`
          // below is the fallback for browsers without dvh support.
          minHeight: '100vh',
          '@supports (min-height: 100dvh)': { minHeight: '100dvh' },
          backgroundColor: theme.palette.background.default,
        }}
      >
        <AppBar />
        {/* `minWidth: 0` on the ROW as well as on `<main>`: the row is itself a
              flex item of the column above, and a runaway intrinsic width
              propagates through every level that omits it. */}
        <Box sx={{ display: 'flex', flexGrow: 1, minWidth: 0 }}>
          {/* Focus order follows visual order: rail, then main — which is also
                their DOM order here, so no tabindex juggling is needed. */}
          {showRail && <NavigationRail />}
          <Box
            component="main"
            sx={{
              flexGrow: 1,
              // Load-bearing, not cosmetic. A flex item's `min-width` defaults to
              // `auto` — its min-content width — so without this, any descendant
              // reporting a large intrinsic inline size (a wide table, a long
              // unbroken string) cannot be shrunk and widens the whole app shell
              // past the viewport. This is also what a DataTable embedded in this
              // flex child requires of its host.
              minWidth: 0,
              p: 3,
              // Clears the fixed bottom bar, which only exists below `sm` — the
              // same breakpoint `BottomNav` gates on. Keeping this coupled is what
              // stops 600–899px from carrying 80px of padding for a bar that is
              // not mounted there.
              pb: { xs: 10, sm: 3 },
            }}
          >
            {/* Issue #258, epic #254. Above the page rather than inside any one
                  of them, because "this deployment is deliberately out of service"
                  is a property of the shell, not of whatever the operator happens
                  to be looking at. It renders NOTHING — no element, no spacing —
                  for anyone without `system_settings:read` and whenever no window
                  is open, which is every viewer on every ordinary day. */}
            <MaintenanceBanner />
            {/* Issue #277, epic #271. The THIRD component in this strip, and
                  mounted for exactly the reasons the other two are: "what is left
                  to set up" is a property of the session rather than of whatever
                  page happens to be open, and a checklist you abandon on step 2
                  has to be visible from the page you abandoned it on.

                  ⚠ IT IS HERE AND NOT ON `HomePage`. That page's test asserts an
                  exact three-request set and renders the page WITHOUT this layout,
                  so mounting the checklist here is what leaves both the page and
                  its assertion untouched.

                  Renders NOTHING — no element, no spacing — while loading, for a
                  read that failed, once every required step is satisfied, and for
                  anyone who has put the checklist away. */}
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
            <Outlet />
          </Box>
        </Box>
        {/* Mounted only where it renders. `BottomNav` also gates itself on
              `down('sm')` — belt and braces, since a self-gating-but-always-mounted
              bar would still run its hooks at every width. `!showRail` is the exact
              complement of the rail's gate, so there is no width with two navs and
              none with zero. */}
        {!showRail && <BottomNav />}
      </Box>
    </OnboardingProvider>
  );
}

import {
  AppBar as MuiAppBar,
  Toolbar,
  Typography,
  Box,
  IconButton,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  ArrowBack as ArrowBackIcon,
  Brightness4 as DarkModeIcon,
  Brightness7 as LightModeIcon,
} from '@mui/icons-material';
import { useLocation, useNavigate } from 'react-router-dom';
import { APP_NAME } from '@app/shared';
import { useThemeContext } from '../../contexts/ThemeContext';
import { UserMenu } from './UserMenu';
import { NotificationBell } from './NotificationBell';
import {
  ADMIN_SECTIONS,
  ADMIN_HUB_PATH,
  ADMIN_HUB_TITLE,
  settingsPageTitle,
} from '../../config/adminSections';
import type { SettingsSectionDef } from '../../config/adminSections';
import {
  USER_SETTINGS_SECTIONS,
  USER_HUB_PATH,
  USER_HUB_TITLE,
} from '../../config/userSettingsSections';

/**
 * Every settings surface the compact top bar knows how to drill into, in
 * resolution order.
 *
 * A TABLE, not two `??`-chained calls, because the bar needs to know WHICH
 * surface matched and not merely THAT one did — the back button's destination
 * is the matched surface's own hub path, and a boolean "some registry claimed
 * this path" cannot answer that. The `??` chain in issue #95 computes the
 * title correctly and loses exactly the fact the back button needs.
 *
 * Order is admin-first, matching #95's snippet. Nothing currently depends on
 * it — `/admin/settings` does not sit under `/settings`, so at most one entry
 * can ever claim a path — but keeping the declared order identical means the
 * day a surface IS nested under another, this file and the issue still agree.
 *
 * Adding a third settings surface is adding a row here. There is deliberately
 * no per-surface branch anywhere below.
 */
const SETTINGS_SURFACES: {
  sections: SettingsSectionDef[];
  hubPath: string;
  hubTitle: string;
}[] = [
  { sections: ADMIN_SECTIONS, hubPath: ADMIN_HUB_PATH, hubTitle: ADMIN_HUB_TITLE },
  { sections: USER_SETTINGS_SECTIONS, hubPath: USER_HUB_PATH, hubTitle: USER_HUB_TITLE },
];

interface DrillDown {
  /** The resolved page title — a card's title, or the surface's hub title. */
  title: string;
  /** Where the back button goes. See `resolveDrillDown`. */
  upPath: string;
}

/**
 * Resolve a pathname to the compact bar's title and its UP destination, or
 * `null` when the path is not a settings surface at all.
 *
 * UP ONE LEVEL, NEVER `navigate(-1)`. History-relative back is right only when
 * the user actually walked down the hierarchy in this tab. It diverges the
 * moment they arrived any other way — a deep link from an email, a
 * `<Navigate>` redirect off a legacy `/admin/users` URL (#92), an OAuth
 * callback landing them here — and then the entry BEFORE this page is another
 * site, so "back" silently means "leave the app". Structural up is the same
 * arrow every time, which is also what makes it safe to sit next to the OS
 * back gesture rather than duplicate it: the gesture stays history, this stays
 * hierarchy, and the user has both.
 *
 * The hub's own parent is `/` rather than nothing: the hub is the top of the
 * settings hierarchy, so one more level up leaves settings entirely. Below
 * `sm` the bottom bar is already showing library destinations, so this is a
 * shortcut rather than the only exit — but a back arrow that does nothing on
 * one screen of the drill-down is worse than no back arrow at all.
 *
 * NO PERMISSION GATE HERE, unlike the hub and the Console rail, and
 * deliberately: `settingsPageTitle` falls back to the surface's hub title for
 * any path it cannot attribute to a card, so filtering the registry first
 * would relabel a page rather than hide it — the route guard, not the header,
 * is what denies an unpermitted page, and by the time this bar renders the
 * guard has already had its say. Naming a page the user is looking at leaks
 * nothing the page itself does not.
 */
function resolveDrillDown(pathname: string): DrillDown | null {
  for (const surface of SETTINGS_SURFACES) {
    const title = settingsPageTitle(
      surface.sections,
      surface.hubPath,
      surface.hubTitle,
      pathname,
    );
    // `null` means "not this surface" — a different answer from "this surface's
    // own hub" (`hubTitle`). Collapsing the two would put a back arrow on every
    // page in the app; see `settingsPageTitle`'s contract.
    if (title === null) continue;
    return {
      title,
      upPath: pathname === surface.hubPath ? '/' : surface.hubPath,
    };
  }
  return null;
}

/**
 * The top bar — two treatments, chosen by window class AND route.
 *
 * Takes NO props as of issue #55: the `onMenuClick` hamburger callback went
 * away with the drawer it opened. It is removed from the props interface
 * entirely rather than left as an unused optional — a dangling optional handler
 * is exactly how a dead affordance survives a refactor and gets quietly rewired
 * later. Navigation below `sm` is the bottom bar, and at `sm` and up it is the
 * permanent rail; neither needs anything from here.
 *
 * Issue #95, epic #90 adds the DRILL-DOWN treatment: below `sm` on a settings
 * route the wordmark is replaced by a back arrow and the resolved page title.
 * The mobile reference screenshot is back arrow + "Settings" + avatar, and
 * both halves of that swap are load-bearing on a phone — without the arrow
 * there is no way up a level from the header, and the wordmark spends the
 * bar's whole width saying something the user already knows instead of saying
 * which of a dozen settings pages they are on.
 *
 * At `sm` and up the wordmark and toggle come back UNCHANGED, on settings
 * routes too: the rail is mounted there and already shows where the user is,
 * so replacing the wordmark would cost the app's identity and buy nothing.
 */
export function AppBar() {
  const theme = useTheme();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { isDarkMode, toggleMode } = useThemeContext();

  // 600px — `down('sm')`, byte-identical to `BottomNav`'s and `SettingsHub`'s
  // gates and the exact complement of `Layout`'s `showRail` (`up('sm')`).
  //
  // ⚠️ FIVE COUPLED GATES — the full list and the reasoning live in
  // `common/Layout.tsx`. This is member (5), and it is bound most tightly to
  // member (4), `SettingsHub`'s own `isCompactWindow`: that hub is the page
  // body directly under this header. If the two ever disagree the user gets one
  // of exactly two broken screens — a back-arrow drill-down header above a card
  // grid, or a full wordmark toolbar above a drill-down list with no way back
  // up. Do not change this number alone.
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));

  // Resolved at EVERY width even though only the compact branch reads it: it is
  // a pure string lookup over a few dozen registry entries, and hoisting it out
  // of the branch keeps the two treatments a single render decision rather than
  // two code paths that can drift.
  const drillDown = isCompactWindow ? resolveDrillDown(pathname) : null;

  return (
    <MuiAppBar
      position="sticky"
      color="default"
      elevation={0}
      sx={{
        backgroundColor: theme.palette.background.paper,
      }}
    >
      <Toolbar>
        {drillDown ? (
          <>
            {/* `edge="start"` so the 48px touch target's padding hangs off the
                toolbar's inset instead of adding to it — the arrow's GLYPH lines
                up with the content below, which is the whole point of the
                treatment. */}
            <IconButton
              onClick={() => navigate(drillDown.upPath)}
              color="inherit"
              edge="start"
              aria-label="Back"
              sx={{ mr: 1, flexShrink: 0 }}
            >
              <ArrowBackIcon />
            </IconButton>
            {/* `noWrap` with `minWidth: 0`, and both are required. `noWrap`
                alone cannot ellipsize inside a flex row: the item's default
                `min-width: auto` is its min-content width, so a long title
                pushes the avatar off the right edge instead of truncating.
                Not clickable, unlike the wordmark it replaces — on this screen
                the back arrow is the navigation, and a second, invisible target
                that goes somewhere ELSE (home, not up) is a trap. */}
            <Typography
              variant="h6"
              component="div"
              noWrap
              sx={{ fontWeight: 600, minWidth: 0 }}
            >
              {drillDown.title}
            </Typography>
          </>
        ) : (
          /* Brand. `edge="start"` alignment now belongs to the title: the
             hamburger that used to hold this slot was deleted with the drawer. */
          <Typography
            variant="h6"
            component="div"
            sx={{
              cursor: 'pointer',
              fontWeight: 600,
              flexShrink: 0,
            }}
            onClick={() => navigate('/')}
          >
            {APP_NAME}
          </Typography>
        )}

        {/* The flexible spacer. Removing it without a replacement packs the
            trailing icon cluster to the LEFT with dead space on the right,
            because nothing else in this row grows — the regression documented
            in MemoriaHub's `docs/audits/mobile-topbar-audit.md` for issue #95.
            It is the only growable item here, which is also what guarantees the
            toolbar can never push the app shell sideways. */}
        <Box aria-hidden sx={{ flexGrow: 1, minWidth: 0 }} />

        {/* The notification centre (#127, epic #109) — MOUNTED IN BOTH
            TREATMENTS, including the compact drill-down, and deliberately not
            given the theme toggle's exemption below.

            The toggle is dropped in the drill-down because it is REDUNDANT
            there: the same setting lives on the Appearance page, two taps
            inside the very surface the bar is heading into. The bell is
            redundant nowhere — it is the only entry point to the notification
            centre anywhere in the app, and a user who cannot see that something
            arrived while they happen to be on a settings screen has simply lost
            the feature for the duration.

            The width still works out. The drill-down carries [back][title][bell]
            [avatar] — three icon buttons, the same count as the wordmark
            treatment's [wordmark][bell][toggle][avatar] — and the title already
            has `noWrap` with `minWidth: 0`, so it ellipsizes into whatever the
            icons leave rather than pushing them off the edge.

            Renders NOTHING when no `NotificationProvider` is mounted, which is
            how every existing standalone `AppBar` test keeps its exact button
            count. See the note on `useNotifications`. */}
        <NotificationBell />

        {/* Theme Toggle — DROPPED in the drill-down, and only there. Three
            controls plus a title do not fit the ~360px the treatment is
            designed for, and this is the one of the three that is redundant:
            the same setting lives on the Appearance page, which is two taps
            away inside the very surface this bar is heading. The user menu
            stays because nothing else reaches sign-out. */}
        {!drillDown && (
          <IconButton
            onClick={toggleMode}
            color="inherit"
            aria-label="toggle theme"
            sx={{ mr: 1, flexShrink: 0 }}
          >
            {isDarkMode ? <LightModeIcon /> : <DarkModeIcon />}
          </IconButton>
        )}

        {/* User Menu */}
        <Box sx={{ flexShrink: 0 }}>
          <UserMenu />
        </Box>
      </Toolbar>
    </MuiAppBar>
  );
}

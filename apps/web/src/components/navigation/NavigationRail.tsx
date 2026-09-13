/**
 * The navigation rail — tablet and desktop chrome for the app's destinations.
 *
 * Issue #55, epic #51. This REPLACES `Sidebar`'s temporary drawer at `sm` and
 * up. The drawer it replaces was `variant="temporary"` at EVERY breakpoint,
 * which is why it needed hardcoded AppBar-height offsets, `disablePortal`, and
 * a `setTimeout(() => navigate(path), 0)` to let the close animation finish
 * before the route changed. A rail is always visible, so navigating costs ZERO
 * taps where a drawer costs one before navigation can even begin — and with no
 * drawer to close, that navigate-after-close race cannot occur at all.
 *
 * TWO TREATMENTS, ONE COMPONENT
 * -----------------------------
 *   medium  (sm–lg)  →  collapsed, 56px, icon over a short caption
 *   expanded (≥ lg)  →  expanded, 220px, labelled rows + a collapse toggle
 *
 * Both treatments share one FOOT: the destinations the model marks `pinned`
 * (Console today) sit below a divider at the bottom of the rail, above the
 * collapse toggle, rather than inline with the library destinations — see the
 * render and `config/destinations.ts` (#105).
 *
 * A desktop user may collapse the rail to the tablet treatment; the choice
 * persists in `user_settings.navigation.railCollapsed`.
 *
 * The medium tier is ALWAYS collapsed regardless of that preference. Honouring
 * a stale `railCollapsed: false` below `lg` would render a 220px rail on a
 * 600px screen — a third of the viewport spent on chrome.
 *
 * CONSOLE MODE — and where it deliberately stops
 * ----------------------------------------------
 * Issue #94, epic #90. On any `/admin/*` route the rail swaps its CONTENTS for
 * the admin sections declared in `config/adminSections.tsx`, promoting
 * `SettingsHubPage`'s permission-gated cards from a page into navigation. Every
 * settings-to-settings move used to have to route back through the hub landing
 * page and pick another card, while 220px of chrome showed three rows that were
 * not the ones the user needed.
 *
 * It swaps ONLY WHEN EXPANDED, and that asymmetry is deliberate — do not
 * "fix" it. A 56px column cannot host labelled group headers, and a stack of
 * near-identical unlabelled admin icons is worse than no swap at all. So at the
 * medium tier, and whenever a desktop user has collapsed the rail, the rail
 * keeps LIBRARY navigation with `Console` marked active and `SettingsHubPage`
 * IS the admin navigation. That is exactly the reasoning epic #90 applies to
 * the phone (no rail at all, so the hub is a drill-down), applied to the other
 * size class that has no room for group headers either — and it preserves the
 * guarantee that the user is always one click out of the admin surface.
 *
 * Console mode also invents no admin IA of its own: it reads the same
 * `ADMIN_SECTIONS` array through the same `visibleSettingsSections` gate as the
 * hub and the AppBar title resolver, so the three cannot disagree about what
 * exists or who may see it.
 */

import { useMemo } from 'react';
import {
  Box,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import type { SvgIconComponent } from '@mui/icons-material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { useNavigationPrefs } from '../../hooks/useNavigationPrefs';
import {
  DESTINATIONS,
  isDestinationVisible,
  owns,
  resolveActiveDestination,
} from '../../config/destinations';
import { ADMIN_SECTIONS, visibleSettingsSections } from '../../config/adminSections';

/**
 * 56px — Material 3's collapsed-rail width, and a 24px icon centred in it still
 * leaves room for a caption below.
 *
 * DELIBERATELY UNCHANGED BY #105. The truncated captions that issue reports are
 * a padding problem, not a width one: 56px minus the row's old 16px of margin
 * and padding left a 40px text box, and the fix reclaims 8px of that chrome
 * (see the collapsed branch of `RailRow`'s `sx`) rather than spending shell
 * width on every screen from `sm` up to fit two words.
 */
export const RAIL_WIDTH_COLLAPSED = 56;
export const RAIL_WIDTH_EXPANDED = 220;

/**
 * The AppBar's `Toolbar` height at `sm` and up (MUI's default Toolbar steps to
 * 64px at exactly that breakpoint), which is the only place the rail renders.
 */
const APPBAR_HEIGHT = 64;

interface RailRowProps {
  to: string;
  Icon: SvgIconComponent;
  /** Shown when expanded. */
  label: string;
  /**
   * Shown when collapsed, where 56px will not hold "System Settings". The
   * visible text is `aria-hidden` and the FULL name travels in
   * `accessibleName`, so the label reaches assistive technology in both
   * treatments. Optional because Console-mode rows are expanded-only and so
   * never render a caption at all.
   */
  compactLabel?: string;
  /**
   * The row's accessible name, stated EXPLICITLY rather than derived from
   * `label` (#94).
   *
   * The two callers want different things from it and a single derived value
   * cannot serve both: a destination's `label` is a navigation noun ("User
   * Settings") that reads correctly as a name, while a Console card's title is
   * already the page's full text ("Users & Allowlist") and must be passed through
   * verbatim. Making the caller name the row means neither site is guessing,
   * and a future row that needs a name unlike its label — a count, a state —
   * has somewhere to put it instead of overloading `label`.
   */
  accessibleName: string;
  active: boolean;
  expanded: boolean;
}

function RailRow({
  to,
  Icon,
  label,
  compactLabel,
  accessibleName,
  active,
  expanded,
}: RailRowProps) {
  const theme = useTheme();

  const button = (
    // A real link: focusable, middle-clickable, and it survives a keyboard user
    // tabbing the rail. The `onClick` handler this replaces gave up all three,
    // and needed a `setTimeout` to sequence itself against the drawer close.
    <ListItemButton
      component={RouterLink}
      to={to}
      selected={active}
      // `selected` is a VISUAL state only; assistive technology needs the
      // explicit landmark.
      aria-current={active ? 'page' : undefined}
      aria-label={accessibleName}
      sx={{
        borderRadius: 1,
        mx: 0.5,
        // `min-width: auto` on a flex item is a hard floor at its min-content
        // width, so one long label would widen the rail — and through it the
        // whole app shell.
        minWidth: 0,
        ...(expanded
          ? { py: 0.75 }
          : {
              flexDirection: 'column',
              alignItems: 'center',
              gap: 0.25,
              // HORIZONTAL SPACE IS THE SCARCE RESOURCE AT 56px (#105), so the
              // collapsed row reclaims it from its own chrome rather than from
              // the caption. `mx: 0.5` + `px: 0.5` above left a 40px text box,
              // and the captions this app actually ships do not fit in it: at
              // the 0.625rem below, "Settings" measures 41.2px and "Console"
              // 41.1px in Inter (39.2 / 38.7 in Roboto, 43.7 / 42.0 in the
              // widest sans fallback), all including `caption`'s 0.03333em
              // letter-spacing. So both ellipsised — `Setti…`, `Cons…`.
              //
              // Halving both to 0.25 (2px each) reclaims 8px for a 48px box,
              // which clears the widest of those by 4px. The alternatives were
              // both worse: widening `RAIL_WIDTH_COLLAPSED` past 56 spends
              // shell width on every screen to fix a caption, and shortening
              // the `compactLabel`s throws away the words that make the row
              // legible at a glance. Nothing is lost here — the row's visual
              // inset is set by its CENTRED contents, not by this padding,
              // which only ever acted as a clip boundary.
              //
              // `mx` is not zeroed: those 2px keep the selected row's rounded
              // highlight off the rail's right border.
              mx: 0.25,
              px: 0.25,
              py: 0.75,
            }),
        // Keyboard focus must be visible on every navigation control. Stated
        // explicitly rather than relying on the theme's default, which a later
        // theme change could quietly remove.
        '&.Mui-focusVisible': {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: -2,
        },
      }}
    >
      <ListItemIcon
        sx={{
          color: active ? theme.palette.primary.main : theme.palette.text.secondary,
          minWidth: expanded ? 40 : 'auto',
          justifyContent: 'center',
        }}
      >
        <Icon fontSize={expanded ? 'medium' : 'small'} />
      </ListItemIcon>

      {expanded ? (
        <ListItemText
          primary={label}
          slotProps={{ primary: { variant: 'body2', noWrap: true } }}
          sx={{ minWidth: 0, my: 0 }}
        />
      ) : (
        <Typography
          aria-hidden
          variant="caption"
          noWrap
          sx={{
            fontSize: '0.625rem',
            lineHeight: 1.2,
            maxWidth: '100%',
            color: active ? theme.palette.primary.main : theme.palette.text.secondary,
          }}
        >
          {compactLabel ?? label}
        </Typography>
      )}
    </ListItemButton>
  );

  return (
    <ListItem disablePadding sx={{ minWidth: 0 }}>
      {/* A tooltip only where the visible text is abbreviated. It sits on top of
          the accessible name above, never as a substitute for it — a tooltip is
          a pointer affordance and reaches neither a screen reader reliably nor
          a keyboard-only user at all. */}
      {expanded ? button : <Tooltip title={label} placement="right">{button}</Tooltip>}
    </ListItem>
  );
}

export function NavigationRail() {
  const theme = useTheme();
  const { pathname } = useLocation();
  const { hasPermission } = usePermissions();
  const { railCollapsed, toggleRailCollapsed } = useNavigationPrefs();

  // The rail is MOUNTED by `Layout` only at `sm` and up, so this distinguishes
  // the two rail treatments — not "is there a rail at all".
  const isDesktop = useMediaQuery(theme.breakpoints.up('lg'));

  const expanded = isDesktop && !railCollapsed;

  // `owns`, never `pathname.startsWith('/admin')`: a bare prefix test would
  // put the rail into Console mode on a future `/administration` route.
  const isConsole = owns('/admin', pathname);

  // EXPANDED-ONLY, deliberately — see the file header. `expanded` already folds
  // in both ways a rail can be narrow (the medium tier, and a desktop user who
  // collapsed it), so one flag covers both and they cannot drift apart.
  const consoleMode = isConsole && expanded;

  // Active state comes from the destination model, never from a path prefix
  // compared against the row's own `path` — see `config/destinations.ts`.
  const activeDestination = resolveActiveDestination(pathname);

  // `usePermissions`' predicates are memoized, so keying on `hasPermission` is
  // safe: this recomputes when the user's permission set changes, not per render.
  // `isDestinationVisible`, never an inline `destination.permission` check:
  // `console` is gated on EITHER `system_settings:read` OR `users:read` (#92),
  // and an inline check would have shown that row to everyone.
  const visibleDestinations = DESTINATIONS.filter((destination) =>
    isDestinationVisible(destination, hasPermission),
  );

  // TWO GROUPS, ONE MODEL (#105). Console is a MODE, not a peer of the library
  // destinations, and its POSITION at the rail's foot is what says so — inline
  // as the last row it read as a third library destination. The split is driven
  // by `destination.pinned`, never by `key === 'console'`: see the flag's
  // comment in `config/destinations.ts` for why the render must not hold its
  // own opinion about which destination is the admin one.
  //
  // Both lists are derived from `visibleDestinations`, so the permission gate
  // has already run. A user who cannot reach Console gets an EMPTY pinned list,
  // and the foot section below renders nothing at all — no row, and no orphan
  // divider hanging above the collapse toggle.
  const listDestinations = visibleDestinations.filter((destination) => !destination.pinned);
  const pinnedDestinations = visibleDestinations.filter((destination) => destination.pinned);

  // No `query` argument: the RAIL is not searchable, the HUB is (#93). A search
  // field cannot live in 220px beside the rows it filters, and the rail is
  // persistent chrome — filtering it would leave the user staring at navigation
  // that no longer lists where they are.
  const consoleSections = useMemo(
    () => (consoleMode ? visibleSettingsSections(ADMIN_SECTIONS, hasPermission) : []),
    [consoleMode, hasPermission],
  );

  // LONGEST PREFIX WINS, not `owns` alone. Admin paths genuinely nest
  // (`/admin/settings/users` vs a future `/admin/settings/users/:id`), so a
  // plain `owns` test per card lights up TWO rows and emits `aria-current="page"`
  // twice — which tells a screen reader the user is on two pages at once.
  //
  // `resolveActiveDestination` cannot answer this: it resolves DESTINATIONS,
  // and inside Console every one of these rows belongs to the single `console`
  // destination, so it would mark all of them or none.
  const consoleActivePath = useMemo(() => {
    if (!consoleMode) return null;
    return consoleSections
      .flatMap((section) => section.cards)
      .reduce<string | null>((best, card) => {
        // Cards without a route, and inert ones, are not navigable and so are
        // never the active row — the same two skips the render below makes.
        if (!card.path || card.disabled) return best;
        if (!owns(card.path, pathname)) return best;
        return best === null || card.path.length > best.length ? card.path : best;
      }, null);
  }, [consoleMode, consoleSections, pathname]);

  // `disableSticky`: the rail is its own scroll container, and a sticky
  // subheader inside it would pin a group header over the rows of the NEXT
  // group as the user scrolls a long admin list. `backgroundColor: transparent`
  // for the same reason — MUI paints an opaque background precisely so a sticky
  // header can cover what scrolls under it, and it is a visible seam otherwise.
  const subheaderSx = {
    fontSize: '0.65rem',
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color: theme.palette.text.disabled,
    lineHeight: '2rem',
    backgroundColor: 'transparent',
  };

  return (
    <Box
      component="nav"
      // The landmark's name says WHICH MODE it is in (#94). In Console mode its
      // contents are entirely different, and a screen-reader user landing on
      // "Main navigation" full of admin pages has no way to tell which one they
      // are in — or that there is a way back out.
      aria-label={consoleMode ? 'Console navigation' : 'Main navigation'}
      sx={{
        width: expanded ? RAIL_WIDTH_EXPANDED : RAIL_WIDTH_COLLAPSED,
        flexShrink: 0,
        // Load-bearing, not cosmetic: without it a long label inside the rail
        // sets a min-content floor that widens the shell past the viewport.
        // Console mode raises the stakes — "Users & Allowlist" and "Database
        // Backup" are longer than any destination label.
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: theme.palette.background.paper,
        borderRight: `1px solid ${theme.palette.divider}`,
        // Sticky rather than fixed, so the rail participates in the shell's flex
        // row and `main` does not need a hard-coded left offset that would drift
        // from the width above. The old drawer's hardcoded top/height offsets
        // are exactly the drift this avoids.
        position: 'sticky',
        top: APPBAR_HEIGHT,
        alignSelf: 'flex-start',
        height: `calc(100vh - ${APPBAR_HEIGHT}px)`,
        '@supports (height: 100dvh)': {
          height: `calc(100dvh - ${APPBAR_HEIGHT}px)`,
        },
        overflowY: 'auto',
        overflowX: 'hidden',
        transition: theme.transitions.create('width', {
          duration: theme.transitions.duration.shorter,
        }),
        // A 164px width animation is exactly the kind of motion that triggers
        // vestibular discomfort, and the toggle works identically without it.
        '@media (prefers-reduced-motion: reduce)': {
          transition: 'none',
        },
      }}
    >
      {consoleMode ? (
        <Box sx={{ flexGrow: 1, py: 1, minWidth: 0 }}>
          {/* Console is a MODE, so the way out is PERMANENT and at the top —
              never a route the user has to guess at, and never something that
              scrolls off behind a long section list. It also replaces the
              pinned `Console` row at the foot, which is why that row is
              suppressed here (#105): a row pointing at the surface you are
              already inside is dead chrome, and it would compete with the real
              active card for `aria-current`. `active={false}` for the same
              reason — "/" is the destination you are leaving for, not the page
              you are on. */}
          <List dense disablePadding>
            <RailRow
              to="/"
              Icon={ArrowBackIcon}
              label="Back to library"
              accessibleName="Back to library"
              active={false}
              expanded
            />
          </List>
          <Divider sx={{ my: 1 }} />

          {consoleSections.map((section) => (
            <List
              key={section.label}
              dense
              disablePadding
              // A real `ListSubheader` rather than a styled `Typography`: it
              // gives the group an accessible heading tied to the list it
              // labels, so the rail reads as grouped navigation rather than one
              // undifferentiated run of links.
              subheader={
                <ListSubheader disableSticky sx={subheaderSx}>
                  {section.label}
                </ListSubheader>
              }
            >
              {section.cards.map((card) =>
                // Skipped, not rendered inert: a card with no `path` has nowhere
                // to send the user, and a `disabled` one is declared-but-unusable
                // (see `SettingsCardDef`). Either as a rail row would be a link
                // that goes nowhere.
                !card.path || card.disabled ? null : (
                  <RailRow
                    key={card.path}
                    to={card.path}
                    Icon={card.Icon}
                    label={card.title}
                    // The card title IS the full text — nothing to abbreviate
                    // and nothing to expand, so the name is the title verbatim.
                    accessibleName={card.title}
                    active={card.path === consoleActivePath}
                    // Console mode only exists when the rail is expanded, so
                    // this is a constant rather than a read of `expanded`.
                    expanded
                  />
                ),
              )}
            </List>
          ))}
        </Box>
      ) : (
        <Box sx={{ flexGrow: 1, py: 1, minWidth: 0 }}>
          <List dense disablePadding>
            {listDestinations.map((destination) => (
              <RailRow
                key={destination.key}
                to={destination.path}
                Icon={destination.Icon}
                label={destination.label}
                compactLabel={destination.compactLabel}
                accessibleName={destination.label}
                active={activeDestination === destination.key}
                expanded={expanded}
              />
            ))}
          </List>
        </Box>
      )}

      {/* PINNED AT THE FOOT (#105) — Console, and anything else the model marks
          `pinned`. It sits BELOW the flex-grow region above and above the
          collapse toggle, separated by its own divider, because that position
          is the whole point: a mode you switch into, not a third library
          destination you page between.

          It renders in BOTH library treatments — the collapsed medium tier and
          the expanded rail on a non-admin route — which is why it lives out
          here beside the branch rather than inside either arm of it. Only
          `expanded` differs between the two, and `RailRow` already takes that
          as a prop.

          `!consoleMode` is load-bearing and must not be relaxed to "always"
          (#94): inside Console mode the `Back to library` row at the top IS the
          affordance, and a row pointing at the surface you are already inside
          would be dead chrome competing with the real active card for
          `aria-current`. `pinnedDestinations` is already permission-filtered,
          so the length check also covers "this user cannot reach Console" —
          without it an empty list would still draw a divider. */}
      {!consoleMode && pinnedDestinations.length > 0 && (
        <>
          <Divider />
          <List dense disablePadding sx={{ py: 0.5 }}>
            {pinnedDestinations.map((destination) => (
              <RailRow
                key={destination.key}
                to={destination.path}
                Icon={destination.Icon}
                label={destination.label}
                compactLabel={destination.compactLabel}
                accessibleName={destination.label}
                // Still the destination model's answer, not a path test — a
                // pinned row is a relocated destination row, not a shortcut, so
                // it keeps carrying `aria-current` on the routes it owns.
                active={activeDestination === destination.key}
                expanded={expanded}
              />
            ))}
          </List>
        </>
      )}

      {/* The collapse toggle is DESKTOP-ONLY: the medium tier is forced
          collapsed, so a toggle there would either do nothing or produce a
          220px rail on a 600px screen. A real <button> with `aria-expanded` —
          not an icon-shaped div, and not a link.

          It stays in Console mode on purpose: collapsing from there is how a
          desktop user gets the library rail back without leaving the admin
          surface, and it is the same control in the same place either way. */}
      {isDesktop && (
        <>
          <Divider />
          <Box
            sx={{
              display: 'flex',
              justifyContent: expanded ? 'flex-end' : 'center',
              px: 0.5,
              py: 0.5,
            }}
          >
            <IconButton
              size="small"
              onClick={toggleRailCollapsed}
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse navigation' : 'Expand navigation'}
              sx={{
                '&.Mui-focusVisible': {
                  outline: `2px solid ${theme.palette.primary.main}`,
                  outlineOffset: -2,
                },
              }}
            >
              {expanded ? (
                <ChevronLeftIcon fontSize="small" />
              ) : (
                <ChevronRightIcon fontSize="small" />
              )}
            </IconButton>
          </Box>
        </>
      )}
    </Box>
  );
}

export default NavigationRail;

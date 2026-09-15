/**
 * The phone bottom bar — the ONLY navigation chrome below `sm`.
 *
 * Issue #55, epic #51. The temporary drawer that used to be the sole way into
 * every page is gone, and there is no hamburger in the top bar either:
 * Material 3 acknowledges it has no recommended drawer replacement at this
 * size, which is why the answer is a bottom bar and nothing else.
 *
 * FOUR ACTIONS IS THE CEILING, and since issue #106 this app sits exactly at
 * it BY DESIGN rather than by coincidence: the bar draws
 * `BOTTOM_BAR_DESTINATIONS` — every destination the model does NOT mark
 * `pinned` — and there are exactly four of them (Home, Transcripts, Notes,
 * Settings). `showLabels` stays on only because of that; five labelled tabs do
 * not fit at 360px, so a fifth NON-PINNED destination is not an addition but a
 * redesign (an overflow tab, or labels off). A pinned one costs this bar
 * nothing, because the bar never draws pinned destinations at all.
 *
 * WHY CONSOLE IS NOT HERE (#106). It used to be, and it was the fourth tab that
 * forced #57 to merge Transcripts and Notes into one `library` row rather than
 * add a fifth. Console is a MODE — an operator surface — and a bar has no foot
 * to pin a mode to, because it IS the foot: a Console tab sitting beside Home
 * reads as a fifth peer destination however it is styled. It stays reachable
 * below `sm` through the avatar UserMenu, which is where a phone user reaches
 * every other non-destination control, and at `sm` and up it is pinned at the
 * navigation rail's foot. Nothing became unreachable; one row moved.
 *
 * The tabs each user actually sees is still permission-dependent: `transcripts`
 * and `notes` are each gated on the one permission their controller enforces,
 * so a user holding neither sees two.
 *
 * ACTIVE STATE COMES FROM THE DESTINATION MODEL, NOT A PATH PREFIX
 * (`config/destinations.ts`). The `startsWith` chain this replaces would have
 * matched `/settingsfoo` against Settings.
 */

import {
  BottomNavigation,
  BottomNavigationAction,
  Paper,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { useNavigate, useLocation } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import {
  BOTTOM_BAR_DESTINATIONS,
  DESTINATIONS,
  isDestinationVisible,
  resolveActiveDestination,
} from '../../config/destinations';
import type { DestinationKey } from '../../config/destinations';

export function BottomNav() {
  const theme = useTheme();
  // The EXACT complement of `Layout`'s `showRail` (`up('sm')`), and it must
  // stay that way: any drift opens a band with two navigation surfaces or none.
  // 600px is Material 3's compact/medium boundary — see the coupled-gate list
  // in `common/Layout.tsx`.
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));
  const navigate = useNavigate();
  const location = useLocation();
  const { hasPermission } = usePermissions();

  if (!isCompactWindow) return null;

  // `BOTTOM_BAR_DESTINATIONS`, not `DESTINATIONS` (#106): the pinned ones are
  // modes and the bar has nowhere to put a mode — see the file header. Still
  // through `isDestinationVisible` rather than an inline `destination.permission`
  // test, because that is the one function that also knows about `anyPermission`.
  const visibleDestinations = BOTTOM_BAR_DESTINATIONS.filter((destination) =>
    isDestinationVisible(destination, hasPermission),
  );

  const resolved = resolveActiveDestination(location.pathname);
  // `false` — NOT `null` — is what MUI's BottomNavigation wants for "nothing
  // selected", which is the correct rendering on the routes `destinations.ts`
  // leaves deliberately unowned. Passing `null` leaves the component thinking a
  // value was supplied and matching nothing, which is the same picture by
  // accident rather than by contract.
  //
  // A destination the user cannot see also resolves to "nothing selected"
  // rather than to a phantom highlighted tab.
  const active: DestinationKey | false =
    resolved !== null && visibleDestinations.some((d) => d.key === resolved)
      ? resolved
      : false;

  // Resolved against the FULL table rather than the bar's own subset, and that
  // is deliberate: this only ever receives a key the bar itself rendered, so
  // either lookup finds it — and the wider one cannot start returning
  // `undefined` for a key that is legitimately a destination just because the
  // bar stopped drawing it.
  const handleChange = (_: React.SyntheticEvent, value: DestinationKey) => {
    const destination = DESTINATIONS.find((d) => d.key === value);
    if (destination) navigate(destination.path);
  };

  return (
    <Paper
      elevation={3}
      sx={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: theme.zIndex.appBar,
      }}
    >
      <BottomNavigation value={active} onChange={handleChange} showLabels>
        {visibleDestinations.map((destination) => (
          <BottomNavigationAction
            key={destination.key}
            value={destination.key}
            // The COMPACT label: a 4-up bar at 360px gives each tab ~90px, and
            // "User Management" does not fit in it. The full label is the
            // accessible name, so nothing is lost to assistive technology.
            //
            // "Transcripts" is the longest one this bar draws since #106, and
            // it only fits because the theme pins the SELECTED label back to
            // 0.75rem — MUI grows it to 0.875rem by default. See
            // `theme/components.ts`'s `MuiBottomNavigationAction` override.
            label={destination.compactLabel}
            aria-label={destination.label}
            icon={<destination.Icon />}
          />
        ))}
      </BottomNavigation>
    </Paper>
  );
}

export default BottomNav;

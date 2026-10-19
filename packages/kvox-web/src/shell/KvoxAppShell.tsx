import type { ReactElement, ReactNode } from 'react';
import Box from '@mui/material/Box';
import {
  ShellAppBar,
  ShellBottomNav,
  ShellLayout,
  ShellUserMenu,
} from '@marinoscar/platform-web/shell/ui';
import type { ShellUserMenuItem } from '@marinoscar/platform-web/shell/ui';
import type { ShellNavigation } from '@marinoscar/platform-web/shell/headless';

import { BrandLockup } from '../brand/index.js';
import { withoutPinned } from './navigation.js';

/**
 * Props of {@link KvoxAppShell}.
 *
 * @stability experimental
 */
export interface KvoxAppShellProps {
  /** The host's navigation: {@link createKvoxNavigation}'s `navigation`, declared once at module scope. */
  navigation: ShellNavigation;
  /** App bar actions, drawn in both treatments before the theme toggle (web: the notification bell; Desktop: none). */
  actions?: ReactNode;
  /** Shell-wide banners above the page (web: maintenance, onboarding, push). Each should render nothing on an ordinary day. */
  banners?: ReactNode;
  /** Dialogs mounted once for the shell (web: the welcome dialog). */
  overlays?: ReactNode;
  /** Extra rows of the user menu, above sign-out (Desktop: "Open data folder", "About KVox"). */
  userMenuItems?: ShellUserMenuItem[];
  /** Rows rendered inside the user menu after the destinations, given `close` (web: "Getting started"). */
  renderUserMenuItems?: (close: () => void) => ReactNode;
  /**
   * Draw the app bar's light/dark toggle. Default `true`. The toggle exists only
   * under a platform `ShellRoot`/`ShellThemeProvider`; `false` hides it there too.
   */
  showThemeToggle?: boolean;
  /** The brand in the app bar. Default `<BrandLockup />`. */
  brand?: ReactNode;
  /** The page. Default the matched child route (`<Outlet />`). */
  children?: ReactNode;
}

const DEFAULT_BRAND = <BrandLockup />;

/**
 * The KVox app shell, one component for every host: the platform's `ShellLayout`
 * with the KVox brand lockup in the app bar, the left rail, the phone bottom bar
 * and the user menu, all drawn from one `navigation`.
 *
 * @remarks
 * Hosts supply only host facts: the navigation (`createKvoxNavigation`), app bar
 * actions, banners and overlays, user menu rows. Everything else, including the
 * five coupled breakpoint gates, is the platform's: THIS FILE READS NO BREAKPOINT
 * and none may be added (`apps/web/src/__tests__/config/breakpointGates.test.ts`
 * scans this package too).
 *
 * The phone bar gets the navigation without its pinned destinations (a pinned
 * destination is a mode, never a peer on the bar; {@link withoutPinned}), so a host
 * never builds a second navigation for it.
 *
 * It makes no request of its own. In a local single-user host mount it under the
 * platform's `LocalIdentityProvider` and a `ShellPreferencesProvider`; in a server
 * host, under the usual `AuthProvider`.
 *
 * Render it as a layout route element, so the matched child renders in its
 * `<Outlet />`.
 *
 * @param props - see {@link KvoxAppShellProps}.
 * @returns the shell.
 *
 * @example
 * ```tsx
 * <Route element={<KvoxAppShell navigation={navigation} userMenuItems={ITEMS} />}>
 *   {renderKvoxRoutes(kvoxNotesRoutes)}
 * </Route>
 * ```
 *
 * @extensionPoint slot
 * @stability experimental
 */
export function KvoxAppShell({
  navigation,
  actions,
  banners,
  overlays,
  userMenuItems,
  renderUserMenuItems,
  showThemeToggle = true,
  brand = DEFAULT_BRAND,
  children,
}: KvoxAppShellProps): ReactElement {
  const appBar = (
    <ShellAppBar
      navigation={navigation}
      brand={brand}
      actions={actions}
      userMenu={
        <ShellUserMenu
          navigation={navigation}
          {...(renderUserMenuItems ? { items: renderUserMenuItems } : {})}
          {...(userMenuItems ? { extraItems: userMenuItems } : {})}
        />
      }
    />
  );

  return (
    <ShellLayout
      navigation={navigation}
      appBar={
        showThemeToggle ? (
          appBar
        ) : (
          // The platform draws the toggle whenever a theme root is mounted and has no
          // prop to turn it off, so it is hidden by its accessible name. `contents`
          // keeps the wrapper out of the bar's layout.
          <Box sx={{ display: 'contents', '& [aria-label="toggle theme"]': { display: 'none' } }}>
            {appBar}
          </Box>
        )
      }
      bottomNav={<ShellBottomNav navigation={withoutPinned(navigation)} />}
      banners={banners}
      overlays={overlays}
    >
      {children}
    </ShellLayout>
  );
}

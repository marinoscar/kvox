/**
 * The client gate — issue #258, epic #254.
 *
 * =============================================================================
 * THE ONE DISTINCTION THIS COMPONENT EXISTS TO MAKE
 * =============================================================================
 *
 * A `503` with `details.reason === 'MAINTENANCE_MODE'` is a planned window, and
 * this renders the operator's message and a retry. A `503` WITHOUT that marker
 * is a crashed API, an exhausted pool, or a proxy with no backend — and it
 * keeps its existing behaviour exactly: the `ApiError` propagates to whichever
 * call site threw it, and that page shows the error it always showed. Nothing
 * here is reached.
 *
 * The decision is not made in this file. `services/api.ts` recognises the
 * marker centrally, on the single error path every request in the application
 * shares, and records a block; this component only renders what was recorded.
 * That separation is why adding an endpoint cannot forget to handle a window.
 *
 * =============================================================================
 * WHY IT SWAPS THE SUBTREE RATHER THAN OVERLAYING IT
 * =============================================================================
 *
 * Because unmounting is what makes the retry work. While the maintenance screen
 * is up the application's pages are gone; clearing the block remounts them, so
 * their effects re-run and re-issue the very requests that failed. The
 * alternative — a modal over a live page — would leave the user looking at half
 * a screen of stale data behind a dialog, and would need every page to grow its
 * own "now refetch" path.
 *
 * =============================================================================
 * WHY ONE ROUTE IS NEVER GATED
 * =============================================================================
 *
 * `MAINTENANCE_ADMIN_PATH` is the client mirror of `@AllowDuringMaintenance()`
 * on `apps/api/src/common/maintenance/maintenance.controller.ts`. The API
 * exempts its own maintenance endpoints for the obvious reason — the switch
 * that ends a window has to be reachable while the window is open — and both
 * halves of that argument have to hold, or an administrator caught by an
 * `allowAdmins: false` window can reach the endpoint and not the page in front
 * of it. Exemption here is about REACHABILITY only: the page still gates itself
 * on `system_settings:read`, and the API still enforces it.
 */

import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import MaintenancePage from '../../pages/MaintenancePage';
import { useMaintenanceBlock } from '../../hooks/useMaintenance';
import { MAINTENANCE_ADMIN_PATH } from '../../services/maintenance';

export interface MaintenanceGateProps {
  children: ReactNode;
}

export function MaintenanceGate({ children }: MaintenanceGateProps) {
  const { block, clear } = useMaintenanceBlock();
  const { pathname } = useLocation();

  // `startsWith` with the separator, not a bare prefix match: the exemption is
  // for that page and anything nested under it, and `…/maintenance-history`
  // must not inherit it. Same segment-boundary rule `config/destinations.ts`
  // and `settingsPageTitle` already apply.
  const isExemptRoute =
    pathname === MAINTENANCE_ADMIN_PATH || pathname.startsWith(`${MAINTENANCE_ADMIN_PATH}/`);

  if (block && !isExemptRoute) {
    return <MaintenancePage block={block} onRetry={clear} />;
  }

  return <>{children}</>;
}

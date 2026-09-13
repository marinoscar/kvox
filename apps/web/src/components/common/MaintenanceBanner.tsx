/**
 * The bypassing administrator's reminder — issue #258, epic #254.
 *
 * =============================================================================
 * WHY THIS IS NECESSARY AT ALL
 * =============================================================================
 *
 * Everybody else finds out about a maintenance window by being refused. An
 * administrator covered by `allowAdmins` is refused nothing: the application
 * looks completely normal to them, which is exactly the person who then forgets
 * it is on and leaves a deployment out of service overnight. Nothing in the
 * ordinary UI would ever tell them otherwise, so this does.
 *
 * =============================================================================
 * "BYPASSING" IS STRUCTURAL, NOT A CONDITION THIS COMPONENT EVALUATES
 * =============================================================================
 *
 * It renders inside `Layout` — i.e. inside `MaintenanceGate`'s children. A
 * viewer who is being BLOCKED never gets here at all; the gate has replaced the
 * whole subtree with the maintenance screen. So "the window is open AND this
 * component is rendering" already means "and this viewer is getting through",
 * and there is no second predicate to write, invert, or get wrong.
 *
 * What is left to check is only whether the window is open, which takes the
 * admin endpoint — the one thing an administrator who is being let through can
 * still call.
 *
 * =============================================================================
 * IT ASKS NOTHING OF THE API FOR ANYONE WHO COULD NOT READ THE ANSWER
 * =============================================================================
 *
 * `GET /api/admin/maintenance` is `system_settings:read`. This component mounts
 * in the shell for EVERY signed-in user, most of whom hold no such permission,
 * so the permission is checked from the session already in memory and the hook
 * is told not to fetch. Firing anyway would buy one predictable 403 per minute
 * per viewer, on every deployment, forever.
 *
 * RENDERS `null` IN EVERY OTHER STATE — loading, error, no permission, window
 * closed. It occupies no space until there is something true to say, which is
 * also what keeps it out of the app's pixel baselines (`tests/visual/`).
 */

import { Alert, AlertTitle, Box, Button } from '@mui/material';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { usePermissions } from '../../hooks/usePermissions';
import { MAINTENANCE_POLL_INTERVAL_MS, useMaintenance } from '../../hooks/useMaintenance';
import { MAINTENANCE_ADMIN_PATH } from '../../services/maintenance';

export function MaintenanceBanner() {
  const { hasPermission } = usePermissions();
  const canRead = hasPermission('system_settings:read');
  const { pathname } = useLocation();

  const { status } = useMaintenance({
    enabled: canRead,
    // Polled rather than fetched once: the window may be opened from another
    // tab, another instance, or by a colleague, and an administrator whose shell
    // mounted before any of that happened would otherwise never be told.
    pollIntervalMs: MAINTENANCE_POLL_INTERVAL_MS,
  });

  if (!canRead || !status?.enabled) {
    return null;
  }

  // Suppressed on the maintenance page itself. That page's entire body is a
  // fuller, editable statement of what this banner summarises, and repeating it
  // directly above would read as two disagreeing controls for one switch.
  const onMaintenancePage =
    pathname === MAINTENANCE_ADMIN_PATH || pathname.startsWith(`${MAINTENANCE_ADMIN_PATH}/`);
  if (onMaintenancePage) {
    return null;
  }

  return (
    <Box sx={{ mb: 3 }}>
      <Alert
        severity="warning"
        action={
          <Button
            component={RouterLink}
            to={MAINTENANCE_ADMIN_PATH}
            color="inherit"
            size="small"
          >
            Manage
          </Button>
        }
      >
        <AlertTitle>Maintenance mode is on</AlertTitle>
        {/* Both facts, and both matter. WHO IS AFFECTED tells the admin what
            their users are experiencing right now — which is the thing they are
            at risk of forgetting — and WHICH LAYER decided tells them where to
            go to turn it off, since an environment override will not yield to
            the page this banner links to. */}
        {status.allowAdmins
          ? 'Everyone except administrators is being turned away.'
          : 'Administrators are not exempt from this window, so the next request you make will be turned away too.'}
        {status.source === 'env' && ' It is being forced on by this deployment’s environment.'}
        {status.source === 'memory' &&
          ' It is being held open by a maintenance task running on the server.'}
      </Alert>
    </Box>
  );
}

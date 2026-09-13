/**
 * The maintenance screen — issue #258, epic #254.
 *
 * What a user sees INSTEAD of the generic error, when and only when the API has
 * answered a `503` carrying `details.reason === 'MAINTENANCE_MODE'`. That
 * condition is decided in exactly one place (`services/maintenance.ts`,
 * consumed by `services/api.ts`), and it is the whole reason this page is
 * allowed to exist: without the marker, a page saying "we will be back shortly"
 * would be an unverifiable guess that would also appear the day the API simply
 * crashed. `MaintenanceGate` is what chooses between this page and the
 * application; an unmarked 503 never reaches here.
 *
 * NOT A ROUTE. There is deliberately no `/maintenance` path: the URL a user
 * asked for is still the URL they want, and redirecting them off it would cost
 * them their place for a window that may be over in two minutes. Rendering in
 * place means the retry below resumes exactly where they were.
 *
 * MOUNTED OUTSIDE `Layout`, so there is no AppBar, no rail and no bell — every
 * one of which is a control that would 503 the moment it was touched.
 */

import { Box, Button, Card, CardContent, Chip, Stack, Typography, useTheme } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import BuildCircleOutlinedIcon from '@mui/icons-material/BuildCircleOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { APP_NAME } from '@app/shared';
import { usePermissions } from '../hooks/usePermissions';
import { MAINTENANCE_ADMIN_PATH } from '../services/maintenance';
import type { MaintenanceBlock } from '../services/maintenance';

export interface MaintenancePageProps {
  /** What the API said when it refused the request. */
  block: MaintenanceBlock;
  /**
   * Forget the block and let the application render again.
   *
   * The children remount when the gate swaps back, so their own effects re-run
   * and re-issue the requests that failed. That is why retrying needs no
   * `window.location.reload()`: a full reload would discard the in-memory
   * access token and send the user back through sign-in for a window that may
   * already be over.
   */
  onRetry: () => void;
}

export default function MaintenancePage({ block, onRetry }: MaintenancePageProps) {
  const theme = useTheme();
  // The maintenance switch is gated on `system_settings:read`, so this is the
  // same question "can this person do anything about it?" — asked of the
  // session that is already in memory, never of the API, which is refusing.
  const { hasPermission } = usePermissions();
  const canManage = hasPermission('system_settings:read');

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.palette.background.default,
        p: 2,
      }}
    >
      <Card sx={{ maxWidth: 520, width: '100%', boxShadow: theme.shadows[10] }}>
        <CardContent sx={{ p: { xs: 3, sm: 4 } }}>
          <Stack spacing={2.5}>
            <Box sx={{ textAlign: 'center' }}>
              <BuildCircleOutlinedIcon
                color="warning"
                sx={{ fontSize: 56 }}
                // Decorative: the heading directly beneath says the same thing
                // in words, and a screen reader announcing "build circle" adds
                // nothing.
                aria-hidden
              />
              {/* The product name comes from `@app/shared`, the one line a fork
                  edits to rebrand (#162). Nothing in this file may hard-code
                  it — and the sentence under it is the OPERATOR'S, delivered by
                  the API, never copy invented here. */}
              <Typography variant="h5" component="h1" sx={{ mt: 1 }}>
                {APP_NAME} is under maintenance
              </Typography>
            </Box>

            <Typography
              color="text.secondary"
              sx={{
                textAlign: 'center',
                // The operator wrote this in a textarea and may well have used
                // line breaks to structure it. Honour them rather than
                // collapsing a three-line notice into one paragraph.
                whiteSpace: 'pre-wrap',
              }}
            >
              {block.message}
            </Typography>

            <Stack spacing={1} sx={{ alignItems: 'center' }}>
              <Button
                variant="contained"
                startIcon={<RefreshIcon />}
                onClick={onRetry}
                // No auto-retry timer, deliberately. A screen that reloaded
                // itself every 30 seconds would fight a user who is reading it,
                // and would keep a browser tab hammering an API that has just
                // asked, in a header, to be left alone.
              >
                Try again
              </Button>
              <Typography variant="caption" color="text.secondary">
                The application asked us to wait about {block.retryAfterSeconds} seconds.
              </Typography>
            </Stack>

            {/* WHAT THE 503 ITSELF TOLD US ABOUT WHO GETS THROUGH. The API puts
                `allowAdmins` on the body precisely so a client can tell "come
                back later" apart from "sign in as an administrator and carry
                on" — the two are different instructions, and guessing between
                them would send half of the users who see this page down a path
                that cannot work. */}
            {block.allowAdmins && !canManage && (
              <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center' }}>
                Administrators can still use the application during this window.
              </Typography>
            )}

            {canManage && (
              <Stack spacing={1} sx={{ alignItems: 'center' }}>
                <Chip size="small" label="You can manage this window" variant="outlined" />
                {/* Reachable BECAUSE the gate lets this one route through, the
                    client mirror of `@AllowDuringMaintenance()` on the API's
                    own maintenance controller. Without it an administrator
                    caught by an `allowAdmins: false` window would be locked out
                    of the only page that turns it off. */}
                <Button component={RouterLink} to={MAINTENANCE_ADMIN_PATH} size="small">
                  Open maintenance settings
                </Button>
              </Stack>
            )}
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}

/**
 * Admin → Settings → Setup guide (`/admin/settings/setup`).
 *
 * The platform's `SetupGuidePage` (issue #481, epic #478) with this app's two additions, both
 * passed through its `BeforeContent` slot so the packaged page keeps owning the checklist, the
 * Re-check button and the Activation section:
 *
 *   - "AI keys belong to each user, not to this deployment". The one fact an administrator
 *     otherwise hunts for: the AI settings page sets policy (which provider, which models,
 *     which ceilings) and holds no API key, because there is no field for one.
 *   - "Invite someone", for a holder of `allowlist:write`: add an address to the allowlist
 *     without leaving the guide. Only allowlisted addresses can sign in, so the `admin.access`
 *     step is otherwise a link away from the thing it asks for.
 *
 * It refreshes the checklist when it mounts. The shell's provider reads once and does not
 * poll, and the page a user returns to after finishing a step elsewhere in the app must not
 * show the step as it was before they did it.
 *
 * The route is gated on `system_settings:read` in `App.tsx`, the exact string the platform
 * adds the `admin` block of `GET /api/onboarding` for.
 */

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import PersonAddAltOutlinedIcon from '@mui/icons-material/PersonAddAltOutlined';
import { usePermissions } from '@marinoscar/platform-web/identity/headless';
import { useOnboarding } from '@marinoscar/platform-web/onboarding/headless';
import { SetupGuidePage, type SetupGuidePageSlots } from '@marinoscar/platform-web/onboarding/ui';

import { AddEmailDialog } from '../admin/AddEmailDialog';
import { addToAllowlist } from '../../services/api';

/** The permission the inline invite needs: what `POST /api/allowlist` enforces. */
export const INVITE_PERMISSION = 'allowlist:write';

function SetupGuideNotes() {
  const { refresh } = useOnboarding();
  const { hasPermission } = usePermissions();
  const canInvite = hasPermission(INVITE_PERMISSION);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invited, setInvited] = useState<string | null>(null);

  const handleInvite = async (email: string, notes?: string) => {
    await addToAllowlist(email, notes);
    setInvited(email);
    await refresh();
  };

  return (
    <Stack spacing={2} sx={{ mb: 3 }}>
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
        <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
          AI keys belong to each user, not to this deployment
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          The AI settings page sets policy — which provider, which models, which ceilings — and
          holds no API key, because there is no field for one. Every user connects their own key
          under Settings → AI Provider, and their usage is billed to their own provider account.
          Nothing you do here gives anybody an AI key.
        </Typography>
      </Paper>

      {canInvite && (
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
          >
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography variant="subtitle1" component="h2" sx={{ fontWeight: 600 }}>
                Invite someone
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Only allowlisted email addresses can sign in. Add one here and they can log in with
                it straight away.
              </Typography>
            </Box>
            <Button
              variant="outlined"
              startIcon={<PersonAddAltOutlinedIcon />}
              onClick={() => setInviteOpen(true)}
              sx={{ flexShrink: 0 }}
            >
              Invite by email
            </Button>
          </Stack>
        </Paper>
      )}

      {/* Mounted unconditionally rather than behind `inviteOpen` so the dialog keeps its own
          field state across a close-and-reopen; absent entirely without the permission,
          because the control that opens it is. */}
      {canInvite && (
        <AddEmailDialog open={inviteOpen} onClose={() => setInviteOpen(false)} onAdd={handleInvite} />
      )}

      <Snackbar
        open={Boolean(invited)}
        autoHideDuration={6000}
        onClose={() => setInvited(null)}
        message={invited ? `${invited} can now sign in.` : ''}
      />
    </Stack>
  );
}

const SLOTS: SetupGuidePageSlots = { BeforeContent: SetupGuideNotes };

export default function SetupGuideRoute() {
  const { refresh } = useOnboarding();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <SetupGuidePage slots={SLOTS} />;
}

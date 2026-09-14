/**
 * The one call to action the signed-in home page is built around — issue #32,
 * epic #19.
 *
 * ONE COMPONENT, TWO PLACES. It is rendered by `HomeHero` at the top of the
 * page and again by `JourneyEmptyState` at the foot of the first-run walkthrough
 * — and a brand-new user sees BOTH at once, because an account with no
 * transcripts renders the hero and the journey together. Two copies of this
 * button would be two chances for the pair to disagree about the thing that
 * actually matters here: whether the deployment can transcribe at all.
 *
 * ⚠ THE DISABLED STATE IS NOT A STYLE, IT IS THE WHOLE POINT. When
 * `GET /api/transcription/config` reports `available: false` there is no
 * provider configured, and `POST /api/transcripts` answers 409 — so a live
 * button here walks the user through picking a file and naming it before the
 * API refuses. Disabling it with the reason attached is the difference between
 * "this deployment is not set up yet" and "this app is broken".
 *
 * The admin escape hatch is gated on `system_settings:read` — the permission
 * the transcription settings controller actually enforces — and NOT on the
 * admin role, copied deliberately from `NewTranscriptPage`'s identical gate.
 * Offering a link to someone who would be redirected straight back off it is
 * worse than not offering it.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import SettingsIcon from '@mui/icons-material/Settings';
import { useId } from 'react';
import { useNavigate } from 'react-router-dom';

import { usePermissions } from '../../hooks/usePermissions';

export interface NewTranscriptButtonProps {
  /**
   * `GET /api/transcription/config` said this deployment can transcribe.
   *
   * `false` while the probe is still in flight as well as when it answered
   * "no": an enabled button that starts working a moment later is a button a
   * fast user has already pressed.
   */
  available: boolean;
  /** The probe has not answered yet — say nothing rather than say "not set up". */
  isChecking?: boolean;
  /**
   * Full width, for the phone layout.
   *
   * A PROP RATHER THAN A BREAKPOINT READ INSIDE THIS COMPONENT. The two callers
   * want different things at the same width (the hero's button is inline from
   * `sm` up, the journey's stays full width inside its narrow card), and a
   * `useMediaQuery` here would make that impossible without adding a sixth
   * coupled breakpoint gate to the five `docs/specs/settings-ui.md` §5 already
   * pins together.
   */
  fullWidth?: boolean;
  size?: 'medium' | 'large';
}

export function NewTranscriptButton({
  available,
  isChecking = false,
  fullWidth = false,
  size = 'large',
}: NewTranscriptButtonProps) {
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  // `useId`, not a literal: a brand-new account renders this component TWICE
  // at once — once in `HomeHero` and once at the foot of `JourneyEmptyState` —
  // and two elements sharing one `id` is both invalid and an axe failure
  // (`duplicate-id-aria`), with `aria-describedby` then resolving to whichever
  // one happens to be first in the document.
  const reasonId = useId();

  // A user without `transcripts:write` cannot create one at all, and
  // `/transcripts/new` is guarded on exactly this permission in `App.tsx`. A
  // disabled button would advertise a capability they will never have; no
  // button is the honest answer.
  if (!hasPermission('transcripts:write')) return null;

  const blocked = !available && !isChecking;

  return (
    <Box sx={{ width: fullWidth ? '100%' : 'auto' }}>
      <Button
        variant="contained"
        size={size}
        startIcon={<AddIcon />}
        disabled={!available}
        aria-describedby={blocked ? reasonId : undefined}
        onClick={() => navigate('/transcripts/new')}
        fullWidth={fullWidth}
        sx={{ width: fullWidth ? '100%' : { xs: '100%', sm: 'auto' } }}
      >
        New transcript
      </Button>

      {blocked && (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mt: 1 }}
          // Tied to the button rather than left floating, so a screen-reader
          // user who lands on a disabled control is told why it is disabled
          // instead of having to go hunting for the sentence below it.
          id={reasonId}
        >
          Transcription is not set up for this workspace yet, so new recordings
          cannot be transcribed.
        </Typography>
      )}

      {blocked && hasPermission('system_settings:read') && (
        <Button
          size="small"
          startIcon={<SettingsIcon />}
          onClick={() => navigate('/admin/settings/transcription')}
          sx={{ mt: 0.5, ml: -1 }}
        >
          Set up transcription
        </Button>
      )}
    </Box>
  );
}

export default NewTranscriptButton;

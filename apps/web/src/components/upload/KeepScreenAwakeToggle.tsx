/**
 * "Keep screen on while uploading" — issue #22, epic #19.
 *
 * The user-facing half of `useScreenWakeLock`. Rendered next to upload
 * controls by issue #30's New-transcript screen and issue #32's home
 * "In progress" section; the preference itself lives in the upload manager so
 * both surfaces show — and change — the same switch.
 *
 * RENDERS NOTHING where the browser has no Screen Wake Lock API. A disabled
 * switch with an explanation would be an apology for a platform gap on a
 * screen that is about uploading a file, and the user cannot act on it.
 */

import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import { useUploadManager } from '../../hooks/useUploadManager';

export function KeepScreenAwakeToggle() {
  const { keepScreenAwake, setKeepScreenAwake, wakeLockSupported } = useUploadManager();

  if (!wakeLockSupported) return null;

  return (
    <Box>
      <FormControlLabel
        control={
          <Switch
            checked={keepScreenAwake}
            onChange={(event) => setKeepScreenAwake(event.target.checked)}
            slotProps={{ input: { 'aria-describedby': 'keep-screen-awake-help' } }}
          />
        }
        label="Keep screen on while uploading"
      />
      {/* Says what the platform actually guarantees. "Keeps uploading in the
          background" would be a promise iOS does not let any web app keep —
          it suspends network activity for a backgrounded tab regardless of
          any wake lock. See `hooks/useScreenWakeLock.ts`. */}
      <Typography
        id="keep-screen-awake-help"
        variant="caption"
        color="text.secondary"
        component="p"
      >
        Prevents the screen from locking while an upload is running. Uploads may still
        pause if you switch to another app.
      </Typography>
    </Box>
  );
}

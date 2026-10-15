/**
 * The "Version x.y.z" line at the foot of both settings hubs (issue #296).
 *
 * It answers "what am I running", for every signed-in user: the version was
 * otherwise visible only at `/admin/settings/about`, behind
 * `system_settings:read`, so a Contributor or a Viewer could not see their own
 * build number anywhere. It asks the API nothing, gates on nothing, and carries
 * no breakpoint read of its own (the five coupled gates are untouched), so it
 * looks the same at every width. It never claims to be the deployed revision;
 * About stays authoritative for that.
 *
 * PLATFORM-ADOPTION-SHIM(466): the line lived inside KVox's own `SettingsHub`.
 * The packaged hub (`@marinoscar/platform-web/settings/ui`) has no footer slot,
 * so the two page bindings render it as a SIBLING under the hub. The negative
 * top margin cancels the hub's own bottom padding (`p: { xs: 2, md: 4 }`) so
 * the line sits where it did. Remove it when the package grows a footer slot
 * (or the line moves into the About card for everyone).
 *
 * `__APP_VERSION__` is a build-time `define` (`vite.config.ts`,
 * `vitest.config.ts`, `visual/vite.config.ts`).
 */

import { Box, Divider, Typography } from '@mui/material';

export function AppVersionLine() {
  return (
    <Box sx={{ px: { xs: 2, md: 4 }, pb: { xs: 2, md: 4 }, mt: { xs: -2, md: -4 } }}>
      <Divider sx={{ mb: 1.5 }} />
      <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
        {`Version ${__APP_VERSION__}`}
      </Typography>
    </Box>
  );
}

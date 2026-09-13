/**
 * Settings → Access Tokens (`/settings/tokens`).
 *
 * Issue #96, epic #90. The Personal Access Tokens card of the stacked
 * `UserSettingsPage`, now an addressable route. THIN BY DESIGN:
 * `PersonalAccessTokens` is not touched — this issue moves where the component
 * is reached from, nothing about what it renders.
 *
 * THE ONE `/settings/*` PAGE THAT DOES NOT USE `UserSettingsSection`, and
 * deliberately. That wrapper exists to share ONE `useUserSettings()` call and
 * its snackbars between the pages that edit the user settings DOCUMENT.
 * Personal access tokens are not part of that document — they are their own
 * resource behind `/api/pat`, and `PersonalAccessTokens` already owns
 * `usePersonalAccessTokens`, its own loading state, and its own inline error
 * `Alert`. Wrapping it anyway would fire a `GET /user-settings` this page never
 * reads, gate the token list behind that unrelated request's spinner, and put a
 * second, empty error surface above a component that already has one.
 *
 * The chrome below is therefore only what the wrapper would have contributed
 * visually: the container, the `h1` and the description, mirroring the
 * `Access Tokens` card in `config/userSettingsSections.tsx` so the hub card,
 * the compact AppBar title (#95) and this `h1` all name the page identically.
 */

import { Box, Container, Typography } from '@mui/material';
import { PersonalAccessTokens } from '../components/settings/PersonalAccessTokens';

export default function UserTokensPage() {
  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Access Tokens
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Create and revoke personal access tokens for API and CLI access.
        </Typography>

        <PersonalAccessTokens />
      </Box>
    </Container>
  );
}

/**
 * The login route (issue #465, epic #462): the packaged `LoginPage` with this app's
 * mark in its `Logo` slot.
 *
 * The page owns the flow (redirect once signed in, the session-expired notice,
 * one button per provider the API offers); this app owns only what identifies the
 * product. The mark sits ABOVE the heading rather than beside it: this is the
 * one screen with no top bar, so it is the only place the brand has to identify
 * itself before the user has anything else to go on. It is decorative
 * (`BrandMark` is `aria-hidden`), because "Welcome" is already the page's `h1`.
 */

import { Box } from '@mui/material';
import { LoginPage as PackagedLoginPage } from '@marinoscar/platform-web/identity/ui';
import type { LoginPageSlots } from '@marinoscar/platform-web/identity/ui';
import { BrandMark } from '@marinoscar/kvox-web/brand';

/** The space between the mark and the heading the package draws under it. */
function KvoxLogo() {
  return (
    <Box sx={{ mb: 2 }} data-testid="login-logo">
      <BrandMark size={56} />
    </Box>
  );
}

/** A module constant: the package keys on slot identity. */
const LOGIN_SLOTS: LoginPageSlots = { Logo: KvoxLogo };

export default function LoginPage() {
  return <PackagedLoginPage slots={LOGIN_SLOTS} />;
}

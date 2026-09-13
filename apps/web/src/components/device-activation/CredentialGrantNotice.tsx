/**
 * The "what am I actually granting?" banner above the Approve / Deny buttons.
 *
 * Issue #141 let the device flow mint a ~90-day personal access token instead
 * of a short-lived session, chosen by the REQUESTING DEVICE via
 * `clientInfo.tokenType`. The approving user saw no difference: a phishing
 * device asking for the 90-day credential rendered exactly like a laptop asking
 * for a week-long session. Consent to something you were not shown is not
 * consent, and this component is where that is repaired.
 *
 * TWO CASES, DELIBERATELY ASYMMETRIC:
 *
 *   - `session` keeps today's calm, informational banner verbatim. It is the
 *     ordinary case — the browser-driven activation that sends no `tokenType`
 *     at all — and dressing it up in warning colours would teach people that
 *     the yellow banner is just what this page looks like. That habit is
 *     precisely what would make the PAT banner useless.
 *   - `pat` switches severity, icon, title and copy, and names the lifetime,
 *     the "survives sign-out" property, and where to revoke it.
 *
 * WHY NO EXTRA CONFIRMATION STEP: the decision here is already deliberate —
 * the user typed or followed a code, and Approve/Deny are the only two things
 * on screen. A second "are you sure?" dialog adds a click, not information,
 * and the well-documented effect of a modal between a person and a button they
 * have already decided to press is that they learn to dismiss it. What was
 * missing was never a speed bump; it was the FACTS, in front of the first
 * click. Revocability (below) is what makes a wrong "Approve" recoverable, so
 * the mitigation is telling people where the undo lives — not making the
 * mistake take two clicks instead of one.
 */

import { Alert, AlertTitle, Box, Link, Typography } from '@mui/material';
import { VpnKey as VpnKeyIcon } from '@mui/icons-material';
import {
  DEVICE_PAT_APPROX_DAYS,
  type DeviceCredentialKind,
} from './credential';

interface CredentialGrantNoticeProps {
  kind: DeviceCredentialKind;
}

/**
 * Where a device-issued PAT is revoked. Kept next to the copy that promises it,
 * so the promise and the destination cannot drift apart: `/settings/tokens`
 * (`UserTokensPage`, registered in `config/userSettingsSections.tsx`) is the
 * page that lists every PAT on the account, including the `Device: …` rows this
 * flow creates.
 */
const TOKENS_PAGE_PATH = '/settings/tokens';

export function CredentialGrantNotice({ kind }: CredentialGrantNoticeProps) {
  if (kind !== 'pat') {
    // UNCHANGED from before #141, down to the wording. Existing behaviour and
    // existing tests both depend on the ordinary path reading exactly as it did.
    return (
      <Alert severity="info" sx={{ mb: 3 }}>
        A device is requesting access to your account. Review the details below
        and choose whether to approve or deny this request.
      </Alert>
    );
  }

  return (
    <Alert
      severity="warning"
      // A key, not the default warning triangle: the triangle says "something
      // went wrong", which is not true — nothing has failed, the request is
      // simply for a different and more powerful kind of credential. The icon
      // should name the thing being granted.
      icon={<VpnKeyIcon />}
      sx={{ mb: 3 }}
    >
      <AlertTitle sx={{ fontWeight: 'bold' }}>
        This device is asking for a long-lived access token
      </AlertTitle>

      <Typography variant="body2" sx={{ mb: 1 }}>
        A device is requesting access to your account. Approving does{' '}
        <Box component="strong">not</Box> create a browser session — it issues a{' '}
        <Box component="strong">personal access token</Box>, a credential that
        works like a password for this account&apos;s API.
      </Typography>

      <Box component="ul" sx={{ pl: 2.5, m: 0, mb: 1 }}>
        {/* The three facts that distinguish this from a session, in the order
            they change the decision: how long, whether signing out stops it,
            and what it can reach. */}
        <Typography component="li" variant="body2">
          It stays valid for about {DEVICE_PAT_APPROX_DAYS} days.
        </Typography>
        <Typography component="li" variant="body2">
          It keeps working while you are signed out, on a device you may not be
          holding — until it expires or you revoke it.
        </Typography>
        <Typography component="li" variant="body2">
          It can do anything your account can do through the API.
        </Typography>
      </Box>

      <Typography variant="body2">
        You can revoke it at any time in{' '}
        <Link
          // A PLAIN ANCHOR opening a new tab, not a router `<Link>`: navigating
          // in place would abandon a device code that is already counting down
          // (the codes live ~15 minutes) and there is no way back to this
          // pending approval afterwards. Opening a second tab lets someone
          // check the Access Tokens page and still return to a live decision.
          // `rel` is mandatory with `target="_blank"` — without `noopener` the
          // opened page gets a handle on this one via `window.opener`.
          href={TOKENS_PAGE_PATH}
          target="_blank"
          rel="noopener noreferrer"
          underline="always"
        >
          Settings &rarr; Access Tokens
        </Link>
        , where it will be listed under the device name shown below.
      </Typography>
    </Alert>
  );
}

/**
 * "Outbound email is not configured" — the Allowlist tab's advisory strip
 * (issue #300, epic #271).
 *
 * =============================================================================
 * THE PROBLEM IT REPORTS
 * =============================================================================
 *
 * Adding an address to the allowlist raises `allowlist.invitation`
 * (`AllowlistService.addEmail` → `notifyAddress`), and that event declares
 * `channels: ['email']` and nothing else — deliberately, because the recipient
 * has no account, no session and no open tab by definition. So on a deployment
 * with no outbound email, inviting somebody does nothing at all for the
 * invitee: the row reads `Pending`, the administrator sees a successful save,
 * and the invited person never learns they can sign in.
 *
 * Nothing in the allowlist API can say this, and it would be the wrong place to
 * say it from — the invitation is dispatched detached, after the write has
 * committed, precisely so a mail failure is a `notification_deliveries` row
 * rather than a failed request. The fact the administrator needs is not "this
 * invitation failed", it is "invitations cannot be delivered here at all", and
 * that is knowable BEFORE they type an address.
 *
 * =============================================================================
 * ⚠ IT WARNS. IT NEVER BLOCKS.
 * =============================================================================
 *
 * The add button is not disabled, no confirmation step is added, and the copy
 * states a CONSEQUENCE rather than a refusal. Inviting somebody you will then
 * tell out of band is a completely legitimate thing to do — it is exactly what
 * this application did before invitations existed — and a deployment that
 * deliberately sends no mail is a supported configuration, not a broken one.
 *
 * =============================================================================
 * ⚠ THE PROBE IS GATED ON THE PERMISSION, AND ASKS NOTHING WITHOUT IT
 * =============================================================================
 *
 * `GET /api/email-settings` is `system_settings:read` (see
 * `email-settings.controller.ts`), and this component renders for anyone who
 * can see the Allowlist tab — which gates on `allowlist:read`, a different
 * permission from a different controller. A user holding one and not the other
 * is an ordinary configuration, so firing the request for them would buy a
 * predictable 403 per visit for an answer the session ALREADY KNOWS cannot be
 * read. `OnboardingContext` gives exactly this reasoning for
 * `GET /api/admin/onboarding`, and `useMaintenance({ enabled })` for the
 * maintenance banner; the gate here is the same shape — a boolean handed to the
 * hook, never a conditional hook call.
 *
 * =============================================================================
 * ⚠ SILENCE IS THE DEFAULT. LOADING AND FAILURE BOTH RENDER NOTHING.
 * =============================================================================
 *
 * The strip appears only when a successful read SAYS email is unconfigured.
 * While the probe is in flight, after it failed, and when it was never sent,
 * this renders `null`. A warning that flashes in on every visit to the tab is
 * noise nobody reads; a warning raised because a fetch failed is an accusation
 * about the deployment built on no evidence, and the remedy it offers would be
 * wrong. That is the posture the onboarding chrome takes — a failed read
 * renders nothing, never an error.
 */

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Button from '@mui/material/Button';
import { Link as RouterLink } from 'react-router-dom';

import { useEmailSettings } from '../../hooks/useEmailSettings';
import { usePermissions } from '../../hooks/usePermissions';
import type { EmailSettings } from '../../types';

/**
 * The permission `email-settings.controller.ts` enforces on its GET, spelled
 * once.
 *
 * ⚠ THE EXACT STRING, never invented and never approximated — the same
 * discipline CLAUDE.md's Settings UI Pattern rule 3 imposes on a registry
 * card's `permission`, and the string the `Email` card in
 * `config/adminSections.tsx` already carries.
 */
export const EMAIL_SETTINGS_PERMISSION = 'system_settings:read';

/** Where the fix is applied. The `Email` card's own `path`. */
export const EMAIL_SETTINGS_PATH = '/admin/settings/email';

/**
 * Can this deployment actually send mail?
 *
 * ⚠ A PROVIDER CHOSEN **AND** THE FEATURE SWITCHED ON. The two are separate
 * axes on purpose (`email-settings.schema.ts`): an administrator may switch
 * mail off for a maintenance window without losing the transport they would
 * otherwise have to retype, so `provider: 'smtp', enabled: false` is a real,
 * deliberate state that sends nothing.
 *
 * This is the API's own predicate, copied from where it is already relied on:
 * `OnboardingService.buildAdminContext` derives `admin.email`'s completion as
 * `email.provider !== null && email.enabled`, with the note that reporting
 * either alone as configured "would make a silently undelivered invitation look
 * like a working one" — which is this warning's subject exactly. Reading only
 * `enabled` would stay quiet on a fresh install (`provider: null`), and reading
 * only `provider` would stay quiet during a maintenance window; both are the
 * failure this component exists to report.
 */
export function isEmailConfigured(settings: EmailSettings): boolean {
  return settings.provider !== null && settings.enabled;
}

export interface EmailNotConfiguredNoticeProps {
  /**
   * Whether to offer the fix.
   *
   * A separate input from "should the warning show at all", because the two are
   * different questions: the fact is worth stating to anybody looking at this
   * tab, while `/admin/settings/email` is a page only a `system_settings:read`
   * holder can open — and a control that navigates somebody to a redirect is
   * worse than no control.
   */
  canOpenEmailSettings: boolean;
}

/**
 * The strip itself, with no knowledge of how the fact was learned.
 *
 * Split from the container below so the "no link" rendering is a real,
 * independently testable shape rather than a branch reachable only through a
 * particular permission set.
 *
 * ⚠ `role="status"`, NOT MUI's default `role="alert"`. An `Alert` is an
 * ASSERTIVE live region: it interrupts whatever a screen reader is reading. The
 * strip appears when a background probe lands rather than in response to
 * anything the user did, and what it reports is a standing property of the
 * deployment, not an emergency. `OnboardingBanner` declines `Alert`'s role for
 * the same reason; here the severity styling is worth keeping, so the role is
 * overridden rather than the component replaced.
 */
export function EmailNotConfiguredNotice({
  canOpenEmailSettings,
}: EmailNotConfiguredNoticeProps) {
  return (
    <Alert
      severity="warning"
      role="status"
      data-testid="allowlist-email-warning"
      sx={{ mb: 2 }}
      action={
        canOpenEmailSettings ? (
          <Button
            component={RouterLink}
            to={EMAIL_SETTINGS_PATH}
            color="inherit"
            size="small"
          >
            Configure email
          </Button>
        ) : undefined
      }
    >
      <AlertTitle>Outbound email is not configured</AlertTitle>
      {/* States the consequence, not a refusal: adding an address still works,
          and the entry is still what lets the person sign in. */}
      You can still add addresses here, but this person will not receive an
      email telling them they can sign in — you will need to let them know
      yourself.
    </Alert>
  );
}

/**
 * The Allowlist tab's warning: probe, gate, and render nothing unless there is
 * something true to say.
 */
export function AllowlistEmailWarning() {
  const { hasPermission } = usePermissions();

  // Read once into a plain boolean and handed to the hook as an ordinary
  // argument. The number and order of hooks below does not depend on it, so a
  // session that resolves after the first render cannot change this
  // component's hook order.
  const canReadEmailSettings = hasPermission(EMAIL_SETTINGS_PERMISSION);

  const { settings, isLoading, loadError } = useEmailSettings({
    enabled: canReadEmailSettings,
  });

  // Three silences, one line. Nothing was asked (`settings` null, never
  // loading), the answer has not landed yet, or the read failed — none of them
  // is evidence about this deployment, and `loadError` in particular must not
  // become a warning: a 500 or a dropped connection says nothing about whether
  // mail works.
  if (isLoading || loadError || !settings) return null;

  if (isEmailConfigured(settings)) return null;

  return <EmailNotConfiguredNotice canOpenEmailSettings={canReadEmailSettings} />;
}

export default AllowlistEmailWarning;

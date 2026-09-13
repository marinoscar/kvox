import { APP_NAME, SafeHtml, html, plainText, renderLayout } from './layout';
import {
  TRANSACTIONAL_EMAIL_HEADERS,
  type RenderedEmail,
} from './email-template.types';

// =============================================================================
// "Your roles changed" template — `security.role_changed` (issue #128, epic #109)
// =============================================================================
//
// THE SECURITY MESSAGE, and the only one of the three whose event is
// `mandatory: true`. A user cannot switch this off, so this template is the
// backstop against a privilege change nobody outside the admin console can
// see. That framing drives two decisions the other two templates do not face.
//
// -----------------------------------------------------------------------------
// 1. IT SHOWS BEFORE AND AFTER, NOT JUST AFTER
// -----------------------------------------------------------------------------
//
// "Your roles are now Viewer" is unactionable: the recipient cannot tell
// whether anything changed, whether they gained access or lost it, or whether
// this is the change they asked for. The DELTA is the alertable fact — a
// silent demotion and a silent promotion are both worth a second look, and
// only the pair shows either.
//
// -----------------------------------------------------------------------------
// 2. IT DOES NOT NAME THE ADMINISTRATOR WHO MADE THE CHANGE
// -----------------------------------------------------------------------------
//
// `allowlist-invitation.email.ts` names the admin deliberately; this one
// deliberately does not, and the difference is the reader. An invitation goes
// to somebody being asked to act, and attribution is what makes it credible.
// This goes to somebody who may have just been demoted or removed, and naming
// the individual who did it discloses an internal identity into an adversarial
// reading of the same message for no operational gain. The recipient's action
// is the same either way: if this was not expected, raise it. `audit_events`
// holds the actor for whoever investigates, which is the controlled place for
// it.
//
// -----------------------------------------------------------------------------
// 3. IT STATES WHEN THE CHANGE TAKES EFFECT, WHICH IS NOT IMMEDIATELY
// -----------------------------------------------------------------------------
//
// Roles are carried in the access token's claims and re-read from the database
// only when that token is refreshed (`AuthService.refreshAccessToken`), so a
// signed-in user keeps their old permissions until their current access token
// expires — up to `JWT_ACCESS_TTL_MINUTES`. Omitting that produces the support
// ticket "you said I'm an Admin now but nothing changed"; stating it makes the
// message accurate and gives the reader the one action that resolves it.
// =============================================================================

/**
 * Everything the role-change message renders.
 *
 * `changedAt` is PASSED IN rather than read from `new Date()` here, per the
 * rule on `TestEmailData`: a template that reads the clock is not a pure
 * function of its input, and "what exactly did we send?" stops being
 * answerable after the fact — which for a security notification is the whole
 * value of having sent it.
 */
export interface RoleChangedEmailData {
  /** The account whose roles changed. Stated so a reader with several knows which. */
  recipientEmail: string;

  /** Roles held BEFORE the change, as stored. May be empty. */
  previousRoles: string[];

  /** Roles held AFTER the change, as stored. May be empty — access can be removed entirely. */
  currentRoles: string[];

  /** When the change was made. Rendered as UTC; see `formatTimestamp`. */
  changedAt: Date;

  /**
   * Absolute URL of the application root, for the CTA. Optional, as everywhere
   * else: with no `APP_URL` configured the layout omits the button rather than
   * rendering one that goes nowhere.
   */
  appUrl?: string;
}

/**
 * Role names as a reader should see them, or an explicit phrase when there are
 * none.
 *
 * THE EMPTY CASE IS THE IMPORTANT ONE. An account can be left with no roles at
 * all, which is the single most alarming outcome this message reports, and
 * rendering it as a blank space beside "Now:" reads as a formatting bug rather
 * than as a loss of access. It gets words.
 */
function formatRoles(roles: string[]): string {
  if (roles.length === 0) return 'None';

  return roles
    .map((role) => role.charAt(0).toUpperCase() + role.slice(1))
    .join(', ');
}

/**
 * ISO 8601, in UTC, with the `Z` left on — the same choice, for the same
 * reason, as `test-email.email.ts`: the server does not know the reader's time
 * zone, and this timestamp's job is to be matched against an audit row or a
 * log line, both of which are UTC.
 */
function formatTimestamp(value: Date): string {
  return value.toISOString();
}

/** One row of the before/after table. `value` is escaped by the `html` tag. */
function changeRow(label: string, value: string): SafeHtml {
  return html`<tr>
    <td
      style="padding:6px 16px 6px 0;font-size:14px;line-height:20px;color:#4b5563;white-space:nowrap;vertical-align:top;"
    >
      ${label}
    </td>
    <td style="padding:6px 0;font-size:14px;line-height:20px;color:#1f2937;vertical-align:top;">
      <strong>${value}</strong>
    </td>
  </tr>`;
}

/**
 * Render the role-change message.
 */
export function roleChangedEmail(data: RoleChangedEmailData): RenderedEmail {
  const previous = formatRoles(data.previousRoles);
  const current = formatRoles(data.currentRoles);
  const timestamp = formatTimestamp(data.changedAt);

  const subject = `Your access to ${APP_NAME} has changed`;

  const rows: SafeHtml[] = [
    changeRow('Account', data.recipientEmail),
    changeRow('Previously', previous),
    changeRow('Now', current),
    changeRow('Changed at', timestamp),
  ];

  const bodyHtml = html`
    <p style="margin:0 0 16px 0;">
      An administrator changed the roles on your ${APP_NAME} account. Your roles
      decide what you can see and do, so this changes your access.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">
      ${rows}
    </table>
    <p style="margin:0 0 16px 0;">
      If you are signed in, the change applies the next time your session
      refreshes. Sign out and back in to apply it straight away.
    </p>
    <p style="margin:0;font-size:13px;line-height:20px;color:#4b5563;">
      If you were not expecting this, contact an administrator now. This
      notification cannot be turned off, because a change to your access should
      never be silent.
    </p>
  `;

  const htmlDocument = renderLayout({
    title: 'Your roles changed',
    // The preheader carries the delta itself. This is the one message whose
    // value can be entirely delivered in the inbox list: a reader who sees
    // "Admin, Viewer -> Viewer" already knows whether to open it.
    previewText: `${previous} → ${current}, changed at ${timestamp}.`,
    bodyHtml,
    ctaLabel: data.appUrl ? `Open ${APP_NAME}` : undefined,
    ctaUrl: data.appUrl,
  });

  const text = plainText({
    title: 'Your roles changed',
    lines: [
      `An administrator changed the roles on your ${APP_NAME} account.`,
      'Your roles decide what you can see and do, so this changes your access.',
      '',
      `  Account:      ${data.recipientEmail}`,
      `  Previously:   ${previous}`,
      `  Now:          ${current}`,
      `  Changed at:   ${timestamp}`,
      '',
      'If you are signed in, the change applies the next time your session refreshes.',
      'Sign out and back in to apply it straight away.',
      '',
      'If you were not expecting this, contact an administrator now. This notification',
      'cannot be turned off, because a change to your access should never be silent.',
    ],
    ctaLabel: data.appUrl ? `Open ${APP_NAME}` : undefined,
    ctaUrl: data.appUrl,
  });

  return {
    subject,
    html: htmlDocument,
    text,
    headers: { ...TRANSACTIONAL_EMAIL_HEADERS },
  };
}

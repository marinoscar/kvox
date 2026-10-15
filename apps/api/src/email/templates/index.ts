import type { EmailTemplate, RenderedEmail } from './email-template.types';
import {
  EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_NAMES,
  emailTemplateRegistry,
  registerEmailTemplate,
  registerEmailTemplates,
  type EmailTemplateRegistrations,
} from './email-template.registry';
import {
  type AllowlistInvitationEmailData,
  allowlistInvitationEmail,
} from './allowlist-invitation.email';
import {
  type AllowlistInvitationReminderEmailData,
  allowlistInvitationReminderEmail,
} from './allowlist-invitation-reminder.email';
import { type BroadcastEmailData, broadcastEmail } from './broadcast.email';
import {
  type BackupFailedEmailData,
  backupFailedEmail,
} from './backup-failed.email';
import { type JobFailedEmailData, jobFailedEmail } from './job-failed.email';
import {
  type NodeOfflineEmailData,
  nodeOfflineEmail,
} from './node-offline.email';
import {
  type RestoreCompletedEmailData,
  restoreCompletedEmail,
} from './restore-completed.email';
import { type RoleChangedEmailData, roleChangedEmail } from './role-changed.email';
import { type TestEmailData, testEmail } from './test-email.email';
import { type UserWelcomeEmailData, userWelcomeEmail } from './user-welcome.email';

// =============================================================================
// Email template registry (issue #123, epic #109)
// =============================================================================
//
// The same idea as `../../notifications/notification-events.ts` on a different
// axis: ONE declaration of what exists, so the thing that dispatches and the
// thing that renders cannot hold different lists.
//
// #125's dispatcher receives an event key from the registry next door and has
// to turn it into a message. Without a keyed registry it does that with a
// `switch` — and a `switch` over strings is exactly the construct that silently
// grows a missing arm, in a code path whose failure mode is "the email was
// never sent" and which therefore produces no error to notice.
//
// -----------------------------------------------------------------------------
// THE LOCK, SINCE #460
// -----------------------------------------------------------------------------
//
// Templates are REGISTERED, not listed (`./email-template.registry.ts`), and
// adding one means two things in the module that owns it:
//
//   1. add `'thing': ThingEmailData` to `EmailTemplateDataMap`, by module
//      augmentation from a domain folder or inline here for a base template
//   2. register `'thing': thingEmail` (`registerEmailTemplate`), from
//      `BASE_EMAIL_TEMPLATES` below or the domain's own record, and add that
//      record to `kvox.manifest.ts`
//
// `EmailTemplateName` is DERIVED from the data map rather than declared as its
// own union, so step 1 cannot produce a name with no data type, and
// `registerEmailTemplate` pins each renderer's data parameter to its name's
// entry in the map. "In the map but never registered" is no longer a compile
// error; the registry refuses a notification binding naming an unregistered
// template, and `index.spec.ts` walks every registered template.
//
// This file is intentionally NOT a Nest provider, for the same reason
// notification-events.ts is not: it is pure data and pure functions, so a test
// or #125 can render a message without standing up DI for a constant.
// =============================================================================

/**
 * Every template, mapped to the data it renders from.
 *
 * The source of truth for {@link EmailTemplateName}. Interface-merged, so a
 * domain adds its own key from its own folder (see the lock above).
 *
 * #128 added the three real event templates. NAMES ARE KEBAB-CASE AND MATCH
 * THE FILE, while the notification event keys that select them are dotted
 * (`user.welcome` -> `user-welcome`): the mapping between the two lives in
 * `EVENT_EMAIL_TEMPLATES` (notifications/channels/email-notification.channel.ts)
 * and is deliberately explicit rather than derived, so a rename on either side
 * is a compile error or a reviewed edit instead of a silent "template not
 * found" at send time.
 */
export interface EmailTemplateDataMap {
  'test-email': TestEmailData;
  'user-welcome': UserWelcomeEmailData;
  'allowlist-invitation': AllowlistInvitationEmailData;
  // #301 (epic #271). The SIBLING of the entry above, and a separate template
  // rather than a flag on it: a reminder opens differently ("you were invited a
  // while ago and have not signed in yet" is not "you have been invited"), and
  // its payload carries the invitation date the original has no reason to
  // state. It deliberately does NOT carry `reminderCount` — see the template's
  // header for why that omission lives in the type.
  'allowlist-invitation-reminder': AllowlistInvitationReminderEmailData;
  'role-changed': RoleChangedEmailData;
  // #322 (epic #319). The odd one out: every entry above renders content this
  // codebase wrote, and this one renders a title and body an administrator
  // typed. Its data type carries no recipient, because a broadcast reads the
  // same for everybody — see broadcast.email.ts.
  broadcast: BroadcastEmailData;

  // #288 (epic #254). The four OPERATIONAL messages. What sets them apart from
  // every entry above is the recipient: these are addressed to whoever holds an
  // administrative permission, not to a user something happened to — see
  // `NotificationsService.notifyPermissionHolders`. Their payloads are
  // correspondingly free of any per-recipient field.
  'job-failed': JobFailedEmailData;
  'node-offline': NodeOfflineEmailData;
  'backup-failed': BackupFailedEmailData;
  'restore-completed': RestoreCompletedEmailData;

  // The transcript and note templates (transcript-ready/-failed/-shared,
  // note-ready/-failed) are NOT listed here since #460: a domain adds its own
  // key by augmenting this interface from its own folder
  // (`transcripts/notifications/`, `notes/notifications/`) and registers the
  // renderer with `registerEmailTemplate`.
}

/**
 * A registered template name.
 *
 * KEYS ARE STABLE IDENTIFIERS and are persisted by #125's delivery records, so
 * a renamed key orphans the history that referenced it. Add a new key rather
 * than editing one — the same rule, for the same reason, as
 * `NotificationEventDef.key`.
 *
 * Kebab-case, matching the file name of the module that implements each one
 * (`test-email` -> `test-email.email.ts`), so a key in a log line leads
 * straight to the source.
 */
export type EmailTemplateName = keyof EmailTemplateDataMap & string;

/**
 * The platform's own templates, in registration order, for `kvox.manifest.ts`
 * to register BEFORE any domain's (a notification binding may only name a
 * template that is already registered).
 *
 * Domain templates are not here: each domain folder exports its own record
 * (`TRANSCRIPTS_EMAIL_TEMPLATES`, `NOTES_EMAIL_TEMPLATES`) and the manifest
 * registers them after this one. `registerEmailTemplates` pins every entry's
 * data parameter to its name's entry in {@link EmailTemplateDataMap}.
 */
export const BASE_EMAIL_TEMPLATES: EmailTemplateRegistrations = {
  'test-email': testEmail,
  'user-welcome': userWelcomeEmail,
  'allowlist-invitation': allowlistInvitationEmail,
  'allowlist-invitation-reminder': allowlistInvitationReminderEmail,
  'role-changed': roleChangedEmail,
  broadcast: broadcastEmail,
  'job-failed': jobFailedEmail,
  'node-offline': nodeOfflineEmail,
  'backup-failed': backupFailedEmail,
  'restore-completed': restoreCompletedEmail,
};

export {
  EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_NAMES,
  emailTemplateRegistry,
  registerEmailTemplate,
  registerEmailTemplates,
};
export type { EmailTemplateRegistrations };

/**
 * Is `value` a registered template name?
 *
 * The guard #125 needs at the boundary where an untyped string -- from a
 * delivery record being retried, from a persisted job -- re-enters the typed
 * world. Without it the only way in is a cast, and a cast is how a
 * decommissioned name becomes an `undefined` function call at runtime.
 */
export function isEmailTemplateName(value: string): value is EmailTemplateName {
  return emailTemplateRegistry.has(value);
}

/**
 * The renderer registered under `name`, or `undefined` when nothing is.
 *
 * RETURNS `undefined` RATHER THAN THROWING, matching `findEvent` in
 * notification-events.ts and for the same reason: the caller is frequently
 * holding a string that came from persisted data, written before a template
 * was removed. Epic #109's rule is that a notification failure never fails the
 * action that triggered it, and an exception thrown while looking up a
 * decommissioned template would do exactly that — take down a role change
 * because of a stale row. The caller decides whether an unknown name is "skip
 * it" or "this is a bug".
 *
 * The return type is deliberately the widest callable shape rather than a
 * per-name signature: by definition the name was not statically known at this
 * call site, so there is no `K` to pin the payload to. Callers that DO know
 * the name should use {@link renderEmailTemplate}, which does pin it.
 */
export function findEmailTemplate(
  name: string,
): EmailTemplate<never> | undefined {
  return emailTemplateRegistry.get(name)?.template;
}

/**
 * Render a template by name, with its data type checked against that name.
 *
 * The typed front door, and the one #125 should use wherever the event being
 * dispatched is known statically: passing `user.welcome`'s payload to
 * `allowlist.invitation` is a compile error here, whereas through
 * {@link findEmailTemplate} it is a runtime surprise in somebody's inbox.
 *
 * Does not catch: a template is a pure, synchronous function of its input
 * (see `EmailTemplate` in ./email-template.types.ts) and has nothing to throw
 * about. Wrapping it would only hide a genuine bug behind a message that
 * silently never sends.
 */
export function renderEmailTemplate<K extends EmailTemplateName>(
  name: K,
  data: EmailTemplateDataMap[K],
): RenderedEmail {
  return (EMAIL_TEMPLATES[name] as EmailTemplate<EmailTemplateDataMap[K]>)(data);
}

// -----------------------------------------------------------------------------
// Public surface of the templates module
// -----------------------------------------------------------------------------
//
// Re-exported here so consumers write `from '../email/templates'` (or, via the
// parent barrel, `from '../email'`) and never reach into an individual file.
// That keeps the internal split — safe-html / layout / types / one file per
// template — free to change without touching call sites.

export {
  APP_NAME,
  plainText,
  renderLayout,
  // The escaping mechanism. See safe-html.ts for why it is a tagged template
  // literal and not a function everyone has to remember to call.
  SafeHtml,
  escapeHtml,
  html,
  safeUrl,
} from './layout';

export {
  TRANSACTIONAL_EMAIL_HEADERS,
  RENDERED_EMAIL_MATCHES_MESSAGE,
  // The one way a rendered template becomes the payload half of an
  // `EmailMessage`. Both call sites use it; see its own note for why a spread
  // per call site is the wrong shape.
  renderedEmailParts,
} from './email-template.types';

// The single embedded asset (see `layout.ts`'s header on CID versus remote).
// `emailLogoAttachment()` is what a template calls to opt in to the masthead
// image; it returns `null` when the committed PNG is unreadable, and the
// layout then renders the text wordmark it always did.
export {
  EMAIL_LOGO_CID,
  EMAIL_LOGO_PATH,
  EMAIL_LOGO_RENDERED_SIZE,
  emailLogoAttachment,
  resetEmailLogoCacheForTests,
} from './brand-logo';

export { testEmail } from './test-email.email';

// The three real event templates (#128). Exported individually as well as
// through the registry, so a caller that knows statically which message it is
// building gets its payload type checked by name.
export { userWelcomeEmail } from './user-welcome.email';
export { allowlistInvitationEmail } from './allowlist-invitation.email';

// The manual invitation reminder (#301, epic #271) — an administrator pressing
// a button, with no scheduler behind it.
export { allowlistInvitationReminderEmail } from './allowlist-invitation-reminder.email';
export { roleChangedEmail } from './role-changed.email';

// The admin-composed broadcast (#322). Registered under ONE name for BOTH
// `admin.broadcast` and `admin.broadcast_critical` — the two keys differ in
// whether a recipient may mute them, not in how the message reads.
export { broadcastEmail } from './broadcast.email';

// The four operational templates (#288). Exported individually as well as
// through the registry, for the same reason as everything above: a call site
// that knows statically which message it is building gets its payload type
// checked by name.
export { jobFailedEmail } from './job-failed.email';
export { nodeOfflineEmail } from './node-offline.email';
export { backupFailedEmail } from './backup-failed.email';
export { restoreCompletedEmail } from './restore-completed.email';


export type { PlainTextOptions, RenderLayoutOptions } from './layout';
export type { EmailTemplate, RenderedEmail } from './email-template.types';
export type { TestEmailData } from './test-email.email';

// The event payload types (#128). These are the CONTRACT between a `notify()`
// call site and the template that renders it: `notify` takes `data: unknown`
// by design, so a call site that annotates its payload with one of these is
// the only place the shape gets checked at all. Every trigger point added by
// #128 does exactly that.
export type { UserWelcomeEmailData } from './user-welcome.email';
export type { AllowlistInvitationEmailData } from './allowlist-invitation.email';
export type { AllowlistInvitationReminderEmailData } from './allowlist-invitation-reminder.email';
export type { RoleChangedEmailData } from './role-changed.email';
export type { BroadcastEmailData } from './broadcast.email';

// The operational payload types (#288). Same contract as the ones above: the
// `notifyPermissionHolders` call site that annotates its payload with one of
// these is the only place the shape is checked at all.
export type { JobFailedEmailData } from './job-failed.email';
export type { NodeOfflineEmailData } from './node-offline.email';
export type {
  BackupFailedEmailData,
  BackupFailureOutcome,
} from './backup-failed.email';
export type { RestoreCompletedEmailData } from './restore-completed.email';

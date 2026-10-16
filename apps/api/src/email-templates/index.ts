// =============================================================================
// This app's email templates (issue #470, epic #467)
// =============================================================================
//
// The platform's email slice owns the layout, the safe-HTML helpers, the
// registry and the transports (`@marinoscar/platform-api/email`); this folder
// holds what belongs to this app: the templates of its own events and the brand mark.
//
//   KVOX_EMAIL_TEMPLATES            new names, registered with
//                                   `registerEmailTemplates` (a duplicate name
//                                   throws at import, so nothing here may share
//                                   a name with a platform template)
//   KVOX_EMAIL_TEMPLATE_OVERRIDES   this app's wording for two platform names
//   registerKvoxEmailTemplateOverrides()   the overrides alone, for the manifest
//   registerKvoxEmailTemplates()    both, in the order the registry needs
//
// THE TWO OVERRIDES, AND THE ONE DROP. The platform ships the identity trio
// (`user-welcome`, `allowlist-invitation`, `role-changed`). Compared with this
// app's, `role-changed` is the same copy line for line, so the platform's is
// used and this app's is gone. `user-welcome` differs (this app's button opens
// the getting-started checklist at `/settings/getting-started`, with a
// paragraph that explains it; the platform's opens the app root) and
// `allowlist-invitation` differs (the product tagline, a bordered attribution
// block, different closing copy). Notification copy changes are out of scope
// for #470, so both keep this app's renderer, registered with
// `{ override: true }` (the platform logs every override once at bootstrap).
// The data types are the platform's own shapes, field for field.
//
// THE NAMES ARE PERSISTED by delivery records and the preference matrix:
// never rename one, add a new name.
//
// THE LOGO is the layout's: `brand-logo.ts` feeds `layout.brandMark` in
// `platform/email/email.options.ts`, and the template registry adds the inline
// MIME part to every message that references it. A template never attaches it.
// =============================================================================

import {
  registerEmailTemplate,
  registerEmailTemplates,
  type EmailTemplateEntry,
} from '@marinoscar/platform-api/email';

import { allowlistInvitationEmail } from './allowlist-invitation.email';
import { allowlistInvitationReminderEmail } from './allowlist-invitation-reminder.email';
import { noteFailedEmail } from './note-failed.email';
import { noteReadyEmail } from './note-ready.email';
import { transcriptFailedEmail } from './transcript-failed.email';
import { transcriptReadyEmail } from './transcript-ready.email';
import { transcriptSharedEmail } from './transcript-shared.email';
import { userWelcomeEmail } from './user-welcome.email';

/** The registrant recorded for these templates in the bootstrap log. */
export const KVOX_EMAIL_REGISTRANT = 'app';

/** This app's own templates, in the order the preference matrix lists their events. */
export const KVOX_EMAIL_TEMPLATES: readonly EmailTemplateEntry[] = [
  { name: 'allowlist-invitation-reminder', render: allowlistInvitationReminderEmail, registrant: KVOX_EMAIL_REGISTRANT },
  { name: 'transcript-ready', render: transcriptReadyEmail, registrant: KVOX_EMAIL_REGISTRANT },
  { name: 'transcript-failed', render: transcriptFailedEmail, registrant: KVOX_EMAIL_REGISTRANT },
  { name: 'transcript-shared', render: transcriptSharedEmail, registrant: KVOX_EMAIL_REGISTRANT },
  { name: 'note-ready', render: noteReadyEmail, registrant: KVOX_EMAIL_REGISTRANT },
  { name: 'note-failed', render: noteFailedEmail, registrant: KVOX_EMAIL_REGISTRANT },
];

/** This app's wording for the platform names it keeps its own copy of. */
export const KVOX_EMAIL_TEMPLATE_OVERRIDES = {
  'user-welcome': userWelcomeEmail,
  'allowlist-invitation': allowlistInvitationEmail,
} as const;

let overridesRegistered = false;

/**
 * Registers {@link KVOX_EMAIL_TEMPLATE_OVERRIDES}. Call it AFTER
 * `registerPlatformEmailTemplates()` (an override of a name nothing registered
 * throws) and BEFORE the registries freeze at bootstrap. Idempotent per
 * process. `platform/notifications/notification.manifest.ts` calls it right
 * after `registerEmailTemplates(KVOX_EMAIL_TEMPLATES)`.
 */
export function registerKvoxEmailTemplateOverrides(): void {
  if (overridesRegistered) return;
  overridesRegistered = true;

  for (const [name, render] of Object.entries(KVOX_EMAIL_TEMPLATE_OVERRIDES)) {
    registerEmailTemplate(name as keyof typeof KVOX_EMAIL_TEMPLATE_OVERRIDES, render as never, {
      override: true,
      registrant: KVOX_EMAIL_REGISTRANT,
    });
  }
}

let registered = false;

/**
 * Registers {@link KVOX_EMAIL_TEMPLATES} and then the overrides: the whole
 * set, for a caller that is not the app's manifest (a script, a test).
 * Idempotent per process. The manifest registers the two halves itself.
 */
export function registerKvoxEmailTemplates(): void {
  if (registered) return;
  registered = true;

  registerEmailTemplates(KVOX_EMAIL_TEMPLATES);
  registerKvoxEmailTemplateOverrides();
}

export { allowlistInvitationEmail, allowlistInvitationReminderEmail, noteFailedEmail, noteReadyEmail };
export { transcriptFailedEmail, transcriptReadyEmail, transcriptSharedEmail, userWelcomeEmail };
export { emailBrandMark, EMAIL_LOGO_CID, EMAIL_LOGO_PATH, EMAIL_LOGO_RENDERED_SIZE } from './brand-logo';

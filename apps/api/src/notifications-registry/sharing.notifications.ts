// =============================================================================
// The sharing slice's notification (issue #485, epic #478)
// =============================================================================
//
// `sharing.shared_with_you`, raised by the platform's `GrantsService` to the
// recipient of a user grant AFTER the grant's transaction committed (through
// `SharingNotifierAdapter`, `platform/sharing/`). It replaces
// `transcripts.transcript_shared` and is the only message a share sends: a
// demotion and a revocation stay silent.
//
// The event definition, the browser renderer and the e-mail wording are the
// platform's; the app supplies the template under its own name
// (`email-templates/shared-with-you.email.ts`). Not `mandatory`: a user who is
// shared recordings all day may turn it off, as they could the old message.
// `groups.invitation` is NOT registered: this app has no groups UI, and the
// dispatcher ignores an event nobody registered.
// =============================================================================

import {
  SHARED_WITH_YOU_EMAIL_TEMPLATE,
  SHARED_WITH_YOU_EVENT,
  sharedWithYouBrowserTemplate,
} from '@marinoscar/platform-api/sharing';
import type { NotificationRegistration } from '@marinoscar/platform-api/notifications';

export const SHARING_NOTIFICATIONS: readonly NotificationRegistration[] = [
  {
    event: { ...SHARED_WITH_YOU_EVENT, channels: [...SHARED_WITH_YOU_EVENT.channels] },
    emailTemplate: SHARED_WITH_YOU_EMAIL_TEMPLATE,
    browserTemplate: (data: never) => sharedWithYouBrowserTemplate(data),
  },
];

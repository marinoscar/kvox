/**
 * What KVox adds to the packaged Users & Allowlist page (issue #465, epic #462).
 *
 * `Tabs` appends tabs AFTER Users and Allowlist, for content that is parallel to
 * them. The Reminders tab is KVox's only one: chasing an invitee who has not
 * signed in is another answer to "who may use this application"
 * (docs/specs/settings-ui.md, rule 2). Its `permission` is the string the
 * reminders list route enforces, `allowlist:read`; the send button inside the
 * panel is gated on `allowlist:write`, the string `POST /:id/reminder` enforces.
 *
 * A module constant: the package keys on slot identity.
 */

import type { UsersPageSlots } from '@marinoscar/platform-web/identity/ui';
import { AllowlistRemindersPanel } from '../components/admin/AllowlistRemindersPanel';

export const USERS_PAGE_SLOTS: UsersPageSlots = {
  Tabs: [
    {
      id: 'reminders',
      label: 'Reminders',
      permission: 'allowlist:read',
      Panel: AllowlistRemindersPanel,
    },
  ],
};

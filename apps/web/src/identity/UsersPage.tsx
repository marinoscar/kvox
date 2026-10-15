/**
 * The `/admin/settings/users` route (issue #465, epic #462): the packaged Users
 * & Allowlist page with this app's Reminders tab appended through `slots.Tabs`.
 *
 * The route gate stays `users:read` (the string `users.controller.ts` enforces)
 * in `App.tsx`; the packaged page gates its Allowlist tab on `allowlist:read`
 * itself, and the Reminders tab carries the same permission (see
 * `usersPageSlots.ts`).
 */

import { UsersPage as PackagedUsersPage } from '@marinoscar/platform-web/identity/ui';
import { USERS_PAGE_SLOTS } from './usersPageSlots';

export default function UsersPage() {
  return <PackagedUsersPage slots={USERS_PAGE_SLOTS} />;
}

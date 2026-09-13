/**
 * Admin → Settings (`/admin/settings`) — the Console hub.
 *
 * Issue #93, epic #90. This replaces the three-tab `SystemSettingsPage` that
 * used to answer this route: tabs are for PARALLEL content, and a settings
 * surface is a hierarchy that grows monotonically — every app built on this
 * baseline adds settings pages, and a tab strip degrades past about five of
 * them. What lands here instead is the searchable, grouped hub, with the card
 * grid from `sm` up and the drill-down list below it.
 *
 * DELIBERATELY THIN. All of the behaviour is in
 * `components/settings/SettingsHub.tsx`, which #96 renders again for the
 * per-user surface at `/settings` with `USER_SETTINGS_SECTIONS`. This file
 * contributes exactly three things — the registry, its scroll key, and its
 * prose — and must never grow admin-specific rendering: the moment the two hubs
 * stop being the same component they start drifting, which is the failure epic
 * #90 exists to prevent.
 *
 * NO PERMISSION CHECK HERE. `App.tsx` wraps this route in `RequirePermission`
 * with the same any-of gate the `console` destination uses, and the hub itself
 * runs `visibleSettingsSections` over `ADMIN_SECTIONS`, so a `users:read`-only
 * admin lands on a hub showing exactly the one card they can use rather than on
 * the access-denied state the placeholder page gave them. A third gate in this
 * file would be a third answer to a question that already has two owners.
 */

import { SettingsHub } from '../../components/settings/SettingsHub';
import { ADMIN_SECTIONS, ADMIN_HUB_TITLE } from '../../config/adminSections';

export default function SettingsHubPage() {
  return (
    <SettingsHub
      sections={ADMIN_SECTIONS}
      // Namespaced per surface: `/settings`'s hub (#96) is a different document
      // of a different height, and a shared key would restore one page's offset
      // onto the other.
      hubKey="admin-settings-hub"
      title={ADMIN_HUB_TITLE}
      subtitle="Manage system configuration, providers, and operational settings."
    />
  );
}

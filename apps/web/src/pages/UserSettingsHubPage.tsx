/**
 * Settings (`/settings`) — the per-user hub.
 *
 * Issue #96, epic #90. This replaces the stacked `UserSettingsPage`, which
 * rendered Theme, Profile and Personal Access Tokens as three cards in one
 * scrolling `Container`. A stack has no group structure, no search, and no
 * per-section URL, so nothing in it could be linked to — and settings is the
 * surface that grows fastest in apps built on this baseline. Shipping the admin
 * hub (#93) while leaving this one a stack would also have left the baseline
 * demonstrating TWO settings patterns, which is the exact thing epic #90 exists
 * to prevent.
 *
 * DELIBERATELY THIN, and the twin of `pages/Admin/SettingsHubPage.tsx`. All of
 * the behaviour — the card grid, the drill-down list below `sm`, the search
 * field, the empty state, the scroll restoration — is in
 * `components/settings/SettingsHub.tsx`, which was parameterised over
 * `(sections, hubKey, title, subtitle)` from the start precisely so this file
 * could be a binding rather than a second hub. A hub COPIED from the admin one
 * would duplicate two responsive treatments and an empty state: four places to
 * fix every future bug. This file contributes exactly three things — the
 * registry, its scroll key, and its prose — and must never grow user-specific
 * rendering.
 *
 * NO `RequirePermission` ON THIS ROUTE, unlike `/admin/settings`. Every
 * authenticated user owns their own settings; `USER_SETTINGS_SECTIONS` declares
 * no `permission` on any card, and `visibleSettingsSections` passes everything
 * through when none is declared. Adding a gate would invent an authorization
 * rule the API does not enforce.
 */

import { SettingsHub } from '../components/settings/SettingsHub';
import { USER_SETTINGS_SECTIONS, USER_HUB_TITLE } from '../config/userSettingsSections';

export default function UserSettingsHubPage() {
  return (
    <SettingsHub
      sections={USER_SETTINGS_SECTIONS}
      // NOT `admin-settings-hub`. The two hubs are different documents of
      // different heights; a shared key would restore one page's scroll offset
      // onto the other, landing the user at an arbitrary point in whichever
      // surface they opened second.
      hubKey="user-settings-hub"
      title={USER_HUB_TITLE}
      // The stacked page's own subtitle, kept verbatim rather than mirroring
      // the admin hub's system-configuration copy: these are the user's
      // preferences, not the deployment's.
      subtitle="Manage your account preferences"
    />
  );
}

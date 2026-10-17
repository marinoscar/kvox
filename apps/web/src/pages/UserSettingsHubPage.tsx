/**
 * Settings (`/settings`) — the per-user hub.
 *
 * Issue #96, epic #90; since #466 (epic #462) a four-prop binding over the
 * packaged `SettingsHub` (`@marinoscar/platform-web/settings/ui`), the twin of
 * `pages/Admin/SettingsHubPage.tsx`. All of the behaviour — the card grid, the
 * drill-down list below `sm`, the search field, the empty state — is the
 * package's; this file contributes the registry, its scroll key, its prose and
 * the three app seams the package takes as props (the permission check, the
 * feature map and the scroll restoration), and the version line
 * (`AppVersionLine`, #296) the packaged hub has no slot for. It must never grow
 * user-specific rendering, and the hub must never be forked.
 *
 * NO `RequirePermission` ON THIS ROUTE, unlike `/admin/settings`. Every
 * authenticated user owns their own settings; `USER_SETTINGS_SECTIONS` declares
 * no gate on the cards every user needs, and the hub's own
 * `visibleSettingsSections` filters the rest.
 *
 * The hub's `down('sm')` compact gate is breakpoint gate 4 of the five coupled
 * gates (root AGENTS.md); it moved into the package unchanged.
 */

import { usePermissions } from '@marinoscar/platform-web/identity/headless';
import { useSettingsFeatures } from '@marinoscar/platform-web/settings/headless';
import { SettingsHub } from '@marinoscar/platform-web/settings/ui';
import { USER_SETTINGS_SECTIONS, USER_HUB_TITLE } from '../config/userSettingsSections';
import { AppVersionLine } from '../components/settings/AppVersionLine';
import { useScrollRestoration } from '@marinoscar/kvox-web/core/headless';

export default function UserSettingsHubPage() {
  const { hasPermission } = usePermissions();
  return (
    <>
      <SettingsHub
        sections={USER_SETTINGS_SECTIONS}
        // NOT `admin-settings-hub`. The two hubs are different documents of
        // different heights; a shared key would restore one page's scroll offset
        // onto the other.
        hubKey="user-settings-hub"
        title={USER_HUB_TITLE}
        subtitle="Manage your account preferences"
        hasPermission={hasPermission}
        features={useSettingsFeatures()}
        useScrollRestoration={useScrollRestoration}
      />
      <AppVersionLine />
    </>
  );
}

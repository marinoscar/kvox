/**
 * Admin → Settings (`/admin/settings`) — the Console hub.
 *
 * Issue #93, epic #90; since #466 (epic #462) a four-prop binding over the
 * packaged `SettingsHub` (`@marinoscar/platform-web/settings/ui`), rendered
 * again for the per-user surface at `/settings`. This file contributes the
 * registry, its scroll key, its prose and the three app seams the package takes
 * as props (the permission check, the feature map and the scroll restoration),
 * plus the version line (`AppVersionLine`, #296) the packaged hub has no slot
 * for. It must never grow admin-specific rendering.
 *
 * NO PERMISSION CHECK HERE. `App.tsx` wraps this route in `RequirePermission`
 * with the same any-of gate the `console` destination uses, and the hub itself
 * runs `visibleSettingsSections` over `ADMIN_SECTIONS`, so a `users:read`-only
 * admin lands on a hub showing exactly the one card they can use.
 *
 * The hub's `down('sm')` compact gate is breakpoint gate 4 of the five coupled
 * gates (root AGENTS.md); it moved into the package unchanged.
 */

import { usePermissions } from '@marinoscar/platform-web/identity/headless';
import { useSettingsFeatures } from '@marinoscar/platform-web/settings/headless';
import { SettingsHub } from '@marinoscar/platform-web/settings/ui';
import { ADMIN_SECTIONS, ADMIN_HUB_TITLE } from '../../config/adminSections';
import { AppVersionLine } from '../../components/settings/AppVersionLine';
import { useScrollRestoration } from '@marinoscar/kvox-web/core/headless';

export default function SettingsHubPage() {
  const { hasPermission } = usePermissions();
  return (
    <>
      <SettingsHub
        sections={ADMIN_SECTIONS}
        // Namespaced per surface: `/settings`'s hub is a different document of a
        // different height, and a shared key would restore one page's offset
        // onto the other.
        hubKey="admin-settings-hub"
        title={ADMIN_HUB_TITLE}
        subtitle="Manage system configuration, providers, and operational settings."
        hasPermission={hasPermission}
        features={useSettingsFeatures()}
        useScrollRestoration={useScrollRestoration}
      />
      <AppVersionLine />
    </>
  );
}

/**
 * KVox's deployment feature keys for the settings hub (issue #466, epic #462).
 *
 * A registry card may declare `feature: '<key>'`; the packaged `SettingsHub`
 * (and `visibleSettingsSections` / `settingsPageTitle`) then show it only when
 * that feature is on, failing closed when no map is passed. The platform
 * declares `ai` and `telemetry`; an app adds its own key by augmenting
 * `SettingsFeatureRegistry` and registering a resolver.
 *
 * `graph` is connected knowledge, switched by `ai.graphEnabled` and read from
 * `GET /api/ai/config`. The resolver reads the app's own
 * `NavigationFeaturesContext`, which already holds that answer (one fetch for
 * the shell, the destinations and now the hub), because a feature resolver must
 * never fetch. The context's default is "off", so a hub rendered outside the
 * shell fails closed, like the `knowledge` destination.
 *
 * Import this module once for its side effect, at module scope, before the
 * first render (`App.tsx`). Registering a new key after
 * `useSettingsFeatures()` has rendered is refused by the package.
 */

import { useOrgsFeature } from '@marinoscar/platform-web/identity/headless';
import { registerSettingsFeature } from '@marinoscar/platform-web/settings/headless';
import { useNavigationFeatures } from '../contexts/NavigationFeaturesContext';

declare module '@marinoscar/platform-web/settings/headless' {
  interface SettingsFeatureRegistry {
    /** Connected knowledge is on for this deployment (`ai.graphEnabled`). */
    graph: true;
    /**
     * Multi-organization deployment. The identity slice's Organization cards
     * declare it; KVox runs single-org and does not spread them, but the key
     * must exist for the card type to check.
     */
    orgs: true;
  }
}

registerSettingsFeature('graph', () => useNavigationFeatures().features.graph === true);
registerSettingsFeature('orgs', useOrgsFeature);

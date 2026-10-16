/**
 * this app's deployment feature keys for the settings hub (issue #466, epic #462).
 *
 * A registry card may declare `feature: '<key>'`; the packaged `SettingsHub`
 * (and `visibleSettingsSections` / `settingsPageTitle`) then show it only when
 * that feature is on, failing closed when no map is passed. The platform
 * declares `ai` and `telemetry`; an app adds its own key by augmenting
 * `SettingsFeatureRegistry` and registering a resolver.
 *
 * `ai` is the platform's own key (AI is switched on in this deployment). It is
 * read from `GET /api/ai/config` through the package's `useAiFeatures`, which
 * reads the shell's one copy of the answer (`platform/AiConfigBinding.tsx`,
 * mounted above the platform host in `App.tsx`) and never fetches. Without the
 * provider it is "off", so the AI models, AI usage and AI Provider cards fail
 * closed; the admin AI card carries no `feature` because it is the switch (#477).
 *
 * `graph` is connected knowledge, switched by `ai.graphEnabled` and read from
 * `GET /api/ai-tasks/config`. The resolver reads `platform/GraphFeatureBinding.tsx`
 * (`AppGraphFeatureProvider`, mounted above the platform host in `App.tsx`), which
 * holds the one copy of that answer for the shell's `knowledge` destination
 * (`feature: 'graph'` in `config/destinations.ts`), its title resolver and the hub,
 * because a feature resolver must never fetch. The context's default is "off", so
 * a surface rendered outside the provider fails closed, like the `knowledge`
 * destination.
 *
 * `telemetry` is the platform's own key (a telemetry store is deployed AND
 * collection is on). It is read from `GET /api/telemetry/config` through the
 * package's `useTelemetryFeatures`, which reads the shell's one copy of the
 * answer (`platform/TelemetryConfigBinding.tsx`, mounted above the platform
 * host in `App.tsx`) and never fetches. Without the provider it is "off", so the
 * Explorer and Dashboard cards fail closed (issue #471).
 *
 * Import this module once for its side effect, at module scope, before the
 * first render (`App.tsx`). Registering a new key after
 * `useSettingsFeatures()` has rendered is refused by the package.
 */

import { useAiFeatures } from '@marinoscar/platform-web/ai/headless';
import { useOrgsFeature } from '@marinoscar/platform-web/identity/headless';
import { registerSettingsFeature } from '@marinoscar/platform-web/settings/headless';
import { useTelemetryFeatures } from '@marinoscar/platform-web/telemetry/headless';
import { useGraphFeature } from '../platform/GraphFeatureBinding';

declare module '@marinoscar/platform-web/settings/headless' {
  interface SettingsFeatureRegistry {
    /** Connected knowledge is on for this deployment (`ai.graphEnabled`). */
    graph: true;
    /**
     * Multi-organization deployment. The identity slice's Organization cards
     * declare it; this app runs single-org and does not spread them, but the key
     * must exist for the card type to check.
     */
    orgs: true;
  }
}

registerSettingsFeature('ai', () => useAiFeatures().ai);
registerSettingsFeature('graph', () => useGraphFeature().graph);
registerSettingsFeature('orgs', useOrgsFeature);
registerSettingsFeature('telemetry', () => useTelemetryFeatures().telemetry);

// =============================================================================
// The `telemetry` system settings namespace (issue #471, epic #467)
// =============================================================================
//
// The platform telemetry slice stores its policy (is telemetry collected, how long
// it is kept, the bounds of an ad-hoc query, the assistant) in the `telemetry`
// namespace of `system_settings`. The package ships the value schema
// (`telemetrySettingsSchema`), the defaults (`TELEMETRY_SETTINGS_DEFAULTS`, OFF
// and inert: a fresh deployment collects nothing nobody asked for) and the PATCH
// merge (`mergeTelemetrySettings`); the namespace DECLARATION is the host's, so it
// is built here and registered by `app-registrations/settings.ts`.
//
// NO SECRET lives in this namespace (`TELEMETRY_SETTINGS_CARRIES_NO_SECRET`): the
// GreptimeDB passwords are in the credential store under purpose
// `telemetry_greptime` (`platform/credentials/credential-purposes.manifest.ts`).
// =============================================================================

import {
  TELEMETRY_SETTINGS_DEFAULTS,
  TELEMETRY_SETTINGS_DESCRIPTION,
  TELEMETRY_SETTINGS_NAMESPACE,
  mergeTelemetrySettings,
  telemetrySettingsSchema,
} from '@marinoscar/platform-api/telemetry';
import type { TelemetrySettings, TelemetrySettingsPatch } from '@marinoscar/platform-api/telemetry';
import type { SystemSettingsNamespace } from '@marinoscar/platform-api/settings';

/** The PATCH branch: every field optional, one level deep into `query` and `assistant`. */
const telemetryPatchSchema = telemetrySettingsSchema.partial().extend({
  query: telemetrySettingsSchema.shape.query.partial().optional(),
  assistant: telemetrySettingsSchema.shape.assistant.partial().optional(),
});

export const TELEMETRY_SYSTEM_SETTINGS: SystemSettingsNamespace<
  typeof TELEMETRY_SETTINGS_NAMESPACE,
  TelemetrySettings,
  TelemetrySettingsPatch
> = {
  key: TELEMETRY_SETTINGS_NAMESPACE,
  description: TELEMETRY_SETTINGS_DESCRIPTION,
  storedSchema: telemetrySettingsSchema,
  patchSchema: telemetryPatchSchema,
  putSchema: telemetrySettingsSchema,
  wirePatchSchema: telemetryPatchSchema,
  responseSchema: telemetrySettingsSchema,
  defaults: TELEMETRY_SETTINGS_DEFAULTS,
  // A PUT that omits the namespace keeps the stored value, as every optional namespace does.
  requiredOnPut: false,
  merge: (current, patch) => mergeTelemetrySettings(current, patch),
};

declare module '@marinoscar/platform-api/settings' {
  interface SystemSettingsNamespaces {
    telemetry: TelemetrySettings;
  }

  interface SystemSettingsNamespaceDeclarations {
    telemetry: typeof TELEMETRY_SYSTEM_SETTINGS;
  }
}


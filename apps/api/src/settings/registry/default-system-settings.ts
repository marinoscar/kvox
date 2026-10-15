// =============================================================================
// The composed default system settings (issue #466)
// =============================================================================
//
// Every registered namespace's `defaults`, composed from the registries at
// import time, in registration order (notifications, jobs, nodes,
// databaseBackup, maintenance, transcription, ai). It replaces the old
// `common/types/settings.types.ts` `DEFAULT_SYSTEM_SETTINGS`, whose key order
// was a historical one (`transcription` ahead of `maintenance`); the registration
// order is the stored key order the platform now writes.
//
// For specs, scripts and fixtures. Production code reads a namespace through
// `SystemSettingsService.getNamespace(key)` or, for a fallback constant, the
// declaration's own `defaults`.
//
// Importing this file registers the namespaces (it imports the registry entry
// point first). A COPY, so a caller that mutates what it was handed cannot
// corrupt the declaration the registry holds.
// =============================================================================

import {
  composeDefaultSystemSettings,
  type SystemSettingsValue,
} from '@marinoscar/platform-api/settings';

import './index';

export const DEFAULT_SYSTEM_SETTINGS: SystemSettingsValue = structuredClone(
  composeDefaultSystemSettings(),
);

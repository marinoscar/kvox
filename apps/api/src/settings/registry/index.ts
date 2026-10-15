// =============================================================================
// Settings registry entry point (issue #466, epic #462)
// =============================================================================
//
// IMPORTING THIS FILE REGISTERS EVERY SETTINGS NAMESPACE. The platform's
// request/response DTOs, the composed schemas and the OpenAPI document are
// composed FROM THE REGISTRIES when `SettingsModule.forRoot()` runs, so every
// entry point (`main.ts`, `app.module.ts`, `test/setup.ts`, `scripts/*`) reaches
// this file first, through `kvox.manifest.ts`.
// =============================================================================

import { registerKvoxSystemSettings } from './system-settings.manifest';
import { registerKvoxUserSettings } from './user-settings.manifest';

registerKvoxSystemSettings();
registerKvoxUserSettings();

export {
  PLATFORM_SYSTEM_SETTINGS_NAMESPACES,
  assembleKvoxSystemSettingsNamespaces,
} from './system-settings.manifest';
export {
  PLATFORM_USER_SETTINGS_NAMESPACES,
  assembleKvoxUserSettingsNamespaces,
} from './user-settings.manifest';

// =============================================================================
// Settings namespace registrations (issue #459), split out of kvox.manifest.ts
// =============================================================================
//
// WHY THIS IS ITS OWN FILE (issue #460). The request/response DTOs, the composed
// settings schemas and `DEFAULT_SYSTEM_SETTINGS` are composed FROM THE SETTINGS
// REGISTRIES AT IMPORT TIME, and they throw on an empty registry. The domain
// registrations in `kvox.manifest.ts` import domain files (onboarding facts,
// user-data hooks, notification templates) that name provider classes, and those
// classes transitively import the DTOs. ES imports evaluate in order, so the
// namespaces must be registered by a module the manifest imports FIRST; doing it
// in the manifest's own body would run after every import had already composed an
// empty registry.
//
// Order is the stored key order and the OpenAPI order: append, never insert.
//   system: notifications, jobs, nodes, databaseBackup, maintenance,
//           transcription, ai
//   user:   dataTables, navigation, notifications, onboarding, graph
// =============================================================================

import { AI_SYSTEM_SETTINGS } from './ai/ai.system-settings';
import { GRAPH_USER_SETTINGS } from './graph/preferences/graph.user-settings';
import {
  registerSystemSettingsNamespaces,
  registerUserSettingsNamespaces,
} from './settings/registry';
import { CORE_SYSTEM_NAMESPACES } from './settings/registry/core-system-namespaces';
import { CORE_USER_NAMESPACES } from './settings/registry/core-user-namespaces';
import { TRANSCRIPTION_SYSTEM_SETTINGS } from './transcription/transcription.system-settings';

let registered = false;

if (!registered) {
  registered = true;

  registerSystemSettingsNamespaces([
    ...CORE_SYSTEM_NAMESPACES,
    TRANSCRIPTION_SYSTEM_SETTINGS,
    AI_SYSTEM_SETTINGS,
  ]);
  registerUserSettingsNamespaces([...CORE_USER_NAMESPACES, GRAPH_USER_SETTINGS]);
}

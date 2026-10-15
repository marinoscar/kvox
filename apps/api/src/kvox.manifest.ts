// =============================================================================
// The app's composition root for static registries (issue #459)
// =============================================================================
//
// IMPORT THIS FIRST. Every entry point (`main.ts`, `scripts/dump-openapi.ts`,
// `scripts/ask-eval/run.ts`, `scripts/kg-eval.ts`, `app.module.ts`,
// `test/setup.ts`) imports it before anything that reads the settings
// registries, because the request/response DTOs, the composed settings schemas
// and `DEFAULT_SYSTEM_SETTINGS` are COMPOSED FROM THEM AT IMPORT TIME. The
// composers throw ("Settings namespaces are not registered: import
// apps/api/src/kvox.manifest first") on an empty registry, so a mis-wired entry
// point fails on start instead of silently stripping a namespace from every
// PATCH.
//
// This is the one file that knows every settings namespace, base and domain
// alike. The settings module itself imports no domain code: `transcription` and
// `graph` are declared beside their own modules and only REGISTERED here, which
// is the whole point of the registry (and of
// `test/architecture/base-domain-boundary.spec.ts`, which exempts this file by
// name).
//
// ORDER IS THE STORED KEY ORDER AND THE OPENAPI ORDER: append, never insert.
//   system: notifications, jobs, nodes, databaseBackup, maintenance,
//           transcription, ai
//   user:   dataTables, navigation, notifications, onboarding, graph
// (`theme` and `profile` are core fields placed ahead of the user namespaces by
// the composers.) `DEFAULT_SYSTEM_SETTINGS` keeps its own historical order on
// top of this one; see `common/types/settings.types.ts`.
//
// Registration is idempotent per process: Jest imports this from `setup.ts` and
// a spec may import it again, and registering a namespace twice is a
// `DUPLICATE_ID` error.
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

// =============================================================================
// The `graph` user settings namespace (issue #459, issue #369, epic #346; schemas and merge moved to
// `@marinoscar/kvox-api/graph` by issue #496, epic #491)
// =============================================================================
//
// One user's preferences over their OWN connected-knowledge graph (docs/specs/ontology.md §7, §13,
// §17.2). The slice owns the schemas, the per-sub-object merge and the limit check; this file only
// binds them to the platform's `UserSettingsNamespace` shape, and `app-registrations/settings.ts`
// registers it. The platform settings module composes it into `GET/PUT/PATCH /api/user-settings`
// without importing this folder.
//
// ABSENT MEANS "DEFAULTS": no `.default()` anywhere; registration refuses one. An out-of-order
// threshold pair answers 400 with the same message it always has.
// =============================================================================

import {
  assertGraphPreferenceLimits,
  graphPreferencesPatchSchema,
  graphPreferencesSchema,
  mergeGraphPreferences,
  type GraphPreferencesPatchValue,
  type GraphPreferencesValue,
} from '@marinoscar/kvox-api/graph';
import type { UserSettingsNamespace } from '@marinoscar/platform-api/settings';

export const GRAPH_USER_SETTINGS: UserSettingsNamespace<'graph', GraphPreferencesValue, GraphPreferencesPatchValue> = {
  key: 'graph',
  description:
    "A user's connected-knowledge preferences: auto-extraction, entity-resolution thresholds and enabled ontology domains.",
  schema: graphPreferencesSchema,
  // `{ graph: null }` resets every graph preference; `{ graph: { resolution: null } }` resets just that
  // sub-object. See `graphPreferencesPatchSchema`.
  patchSchema: graphPreferencesPatchSchema,
  merge: mergeGraphPreferences,
  assertLimits: assertGraphPreferenceLimits,
};

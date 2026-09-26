// =============================================================================
// `graph.preferences_changed` (#369, epic #346)
// =============================================================================
//
// Emitted by `UserSettingsService` after a successful PUT/PATCH of
// `/api/user-settings` whose EFFECTIVE graph preferences changed — i.e. the
// resolved values differ, not merely the stored spelling of them (writing the
// default value explicitly over an absent one is not a change).
//
// ⚠ Listeners must only ENQUEUE (CLAUDE.md "Every Long-Running Activity Is a
// Queue Job"). `EventEmitter2` dispatches synchronously; the emitter guards
// against a throwing listener, but a slow one would still delay the response.
// #364 adds the listener that enqueues `kg.resolve` (`reason:
// 'threshold_change'`) when `resolution` changed; this issue adds none.
//
// The payload carries only the user id and preference values — no content.
// =============================================================================

import type {
  GraphPreferenceSection,
  GraphPreferences,
} from './graph-preferences.defaults';

export const GRAPH_PREFERENCES_CHANGED_EVENT = 'graph.preferences_changed';

export interface GraphPreferencesChangedEvent {
  readonly userId: string;
  /** The sub-objects whose resolved values differ, in a stable order. Never empty. */
  readonly changed: GraphPreferenceSection[];
  readonly previous: GraphPreferences;
  readonly next: GraphPreferences;
}

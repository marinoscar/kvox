// =============================================================================
// `user-settings.namespace-changed` (issue #459)
// =============================================================================
//
// Emitted by `UserSettingsChangeInterceptor` after a successful PUT or PATCH of
// `/api/user-settings`, ONCE for every registered namespace whose stored value
// changed (compared on `JSON.stringify` of the value before and after). It is
// the generic replacement for the graph-specific `graph.preferences_changed`
// emission the service used to make itself: the settings module no longer knows
// what any namespace means, so a module that cares about one namespace
// subscribes here and filters on `key` (the graph module's forwarder,
// `graph/preferences/graph-preferences-change.forwarder.ts`, turns `key ===
// 'graph'` into `graph.preferences_changed`).
//
// ⚠ Listeners must only ENQUEUE (CLAUDE.md "Every Long-Running Activity Is a
// Queue Job"). `EventEmitter2` dispatches synchronously inside the settings
// write; the interceptor guards against a throwing listener, but a slow one would
// still delay the response.
//
// IN-PROCESS ONLY AND NEVER LOGGED. The payload carries values the user already
// owns (their own preferences), not content, but it is not written to a log or
// a queue payload by this code.
//
// PLATFORM-ADOPTION-SHIM(#466). The platform's `UserSettingsNamespace` has no
// change hook and its user-settings service emits no change event, so the event
// is emitted by `user-settings-change.interceptor.ts` (a before/after diff
// around `PUT`/`PATCH /api/user-settings`). A write that does not go through
// those routes (the profile-image upload, the user-data purge) changes only
// `profile` / `onboarding`, which nothing subscribes to. Remove it when the
// platform grows a namespace change hook.
// =============================================================================

export const USER_SETTINGS_NAMESPACE_CHANGED_EVENT =
  'user-settings.namespace-changed';

export interface UserSettingsNamespaceChangedEvent {
  userId: string;
  /** The namespace key, e.g. `'graph'`. */
  key: string;
  /** The stored value before the write; `undefined` when the namespace was absent. */
  previous: unknown;
  /** The stored value after the write; `undefined` when the namespace is now absent. */
  next: unknown;
}

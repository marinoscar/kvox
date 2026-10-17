// =============================================================================
// GraphPreferencesChangeForwarder (issue #459, issue #369, epic #346; moved beside the graph
// configuration by issue #496, epic #491)
// =============================================================================
//
// The platform settings slice does not know what the `graph` user-settings namespace means. It
// announces every namespace whose stored value changed (`user-settings.namespace-changed`,
// `platform/settings/user-settings.events.ts`, emitted by
// `platform/settings/user-settings-change.interceptor.ts` around `PUT|PATCH /api/user-settings`).
// This forwarder is the application's subscription to that announcement. For `key === 'graph'` it
// resolves both sides against the slice's defaults and publishes `graph.preferences_changed` on the
// event port, with the slice's payload, only when the EFFECTIVE preferences changed. Compared after
// resolution, so writing a default explicitly over an absent value, or a PUT restating the same
// preferences, is not a change and emits nothing.
//
// The slice's listener (`GraphPreferencesListener`, in `@marinoscar/kvox-api/graph-extraction`) only
// ENQUEUES, per the queue rule. Synchronous on purpose: the change interceptor wraps the original
// emit in a try/catch so a throwing listener cannot turn a committed write into an error response.
// =============================================================================

import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  GRAPH_PREFERENCES_CHANGED_EVENT,
  changedGraphSections,
  resolveGraphPreferences,
  type GraphPreferencesChangedEvent,
  type GraphPreferencesValue,
} from '@marinoscar/kvox-api/graph';
import { KVOX_EVENTS, type KvoxEventsPort } from '@marinoscar/kvox-api/ports';

import {
  USER_SETTINGS_NAMESPACE_CHANGED_EVENT,
  type UserSettingsNamespaceChangedEvent,
} from '../../platform/settings/user-settings.events';

@Injectable()
export class GraphPreferencesChangeForwarder {
  constructor(@Inject(KVOX_EVENTS) private readonly events: KvoxEventsPort) {}

  @OnEvent(USER_SETTINGS_NAMESPACE_CHANGED_EVENT)
  forward(event: UserSettingsNamespaceChangedEvent): void {
    if (event.key !== 'graph') {
      return;
    }

    const previous = resolveGraphPreferences(event.previous as GraphPreferencesValue | undefined);
    const next = resolveGraphPreferences(event.next as GraphPreferencesValue | undefined);
    const changed = changedGraphSections(previous, next);
    if (changed.length === 0) {
      return;
    }

    const forwarded: GraphPreferencesChangedEvent = {
      userId: event.userId,
      changed,
      previous,
      next,
    };
    this.events.emit(GRAPH_PREFERENCES_CHANGED_EVENT, forwarded);
  }
}

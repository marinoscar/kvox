// =============================================================================
// GraphPreferencesChangeForwarder (issue #459, issue #369, epic #346)
// =============================================================================
//
// The platform settings slice does not know what the `graph` user-settings namespace
// means. It announces every namespace whose stored value changed
// (`user-settings.namespace-changed`, `platform/settings/user-settings.events.ts`,
// emitted since #466 by `platform/settings/user-settings-change.interceptor.ts`
// around `PUT|PATCH /api/user-settings`);
// this forwarder is the graph module's subscription to that announcement. For
// `key === 'graph'` it runs what this app's former `UserSettingsService.emitGraphPreferencesChanged`
// used to run: resolve both sides against `GRAPH_PREFERENCE_DEFAULTS`, and emit
// `graph.preferences_changed` with the same payload, only when the EFFECTIVE
// preferences changed. Compared after resolution, so writing a default
// explicitly over an absent value — or a PUT restating the same preferences —
// is not a change and emits nothing.
//
// The existing listener (`graph/resolution/listeners/graph-preferences.listener.ts`)
// is unchanged and still only ENQUEUES.
//
// Synchronous on purpose: `EventEmitter2` dispatches synchronously, and the
// change interceptor wraps the original emit in a try/catch so a throwing
// listener cannot turn a committed write into an error response. Nothing is
// caught here, so the same guard covers this forwarder and the listeners behind
// it.
// =============================================================================

import { Injectable } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';

import {
  USER_SETTINGS_NAMESPACE_CHANGED_EVENT,
  type UserSettingsNamespaceChangedEvent,
} from '../../platform/settings/user-settings.events';
import {
  changedGraphSections,
  resolveGraphPreferences,
} from './graph-preferences.defaults';
import {
  GRAPH_PREFERENCES_CHANGED_EVENT,
  type GraphPreferencesChangedEvent,
} from './graph-preferences.events';
import type { GraphPreferencesValue } from './graph-preferences.schema';

@Injectable()
export class GraphPreferencesChangeForwarder {
  constructor(private readonly events: EventEmitter2) {}

  @OnEvent(USER_SETTINGS_NAMESPACE_CHANGED_EVENT)
  forward(event: UserSettingsNamespaceChangedEvent): void {
    if (event.key !== 'graph') {
      return;
    }

    const previous = resolveGraphPreferences(
      event.previous as GraphPreferencesValue | undefined,
    );
    const next = resolveGraphPreferences(
      event.next as GraphPreferencesValue | undefined,
    );
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

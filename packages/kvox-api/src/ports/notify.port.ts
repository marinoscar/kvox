// =============================================================================
// KVOX_NOTIFY: the notification port (issue 5.4, epic 486)
// =============================================================================
//
// Domain events that tell a user something (a note is ready, a transcript
// failed). The web edition binds it over the platform notifications slice
// (email, bell, Web Push); Desktop shows an operating-system notification.
//
// `notify` IS DETACHED. It returns before delivery and never throws, so a slow
// or broken channel cannot fail the work that raised it. Call it after the
// triggering write has committed, never inside a transaction. Event keys and
// template names are persisted: never rename one.
// =============================================================================

/**
 * Injection token of {@link KvoxNotifyPort}. The description string is
 * permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const KVOX_NOTIFY = Symbol.for('@marinoscar/kvox/KVOX_NOTIFY');

/**
 * What an in-app or operating-system notification shows.
 *
 * @stability experimental
 */
export interface KvoxBrowserNotification {
  /** The heading. */
  title: string;
  /** The text. */
  body: string;
  /** A root-relative link to open, when there is one. */
  link?: string;
}

/**
 * Declares one notification event.
 *
 * @stability experimental
 */
export interface KvoxNotificationEventDef {
  /** The event key (`notes.note_ready`). Persisted; never renamed. */
  key: string;
  /** The name shown in the preferences matrix. */
  label: string;
  /** What triggers it, for the preferences matrix. */
  description: string;
  /** The channels it can use (`email`, `browser`). */
  channels: readonly string[];
  /** Whether a user who has not chosen receives it. Defaults to true. */
  defaultEnabled?: boolean;
  /** True when the user cannot switch it off. */
  mandatory?: boolean;
  /** The email template name, when `email` is a channel. */
  emailTemplate?: string;
  /** Renders the in-app / OS notification from the event data. */
  browserTemplate?: (data: never) => KvoxBrowserNotification;
}

/**
 * The notification port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface KvoxNotifyPort {
  /**
   * Declares events. Idempotent per key; call it at import or start-up time,
   * before the host freezes its registries.
   *
   * @param defs - the events.
   */
  registerEvents(defs: KvoxNotificationEventDef[]): void;

  /**
   * Raises an event for a user. Returns immediately; delivery is detached and a
   * failure is logged, never thrown.
   *
   * @param eventKey - a registered event key.
   * @param userId - the recipient.
   * @param data - the event data the templates render.
   */
  notify(eventKey: string, userId: string, data: unknown): void;
}

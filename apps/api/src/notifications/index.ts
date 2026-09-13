// =============================================================================
// Notifications — public surface (issues #121/#124/#125, epic #109)
// =============================================================================
//
// #121 shipped the event registry and its helpers. #124 added the endpoint
// that serves that registry to the web app. #125 added the dispatcher, the
// channel abstraction, the preference resolver and the delivery records. #127
// adds the browser channel: the durable `notifications` store, the SSE
// transport, and the notification centre's endpoints.
//
// FOR A FEATURE THAT WANTS TO SEND A NOTIFICATION, THE WHOLE API IS:
//
//     imports: [NotificationsModule]          // in your module
//     constructor(private readonly notifications: NotificationsService) {}
//     await this.notifications.notify('security.role_changed', userId, data);
//
// That call cannot throw, cannot join your transaction, and returns before
// anything is sent. Nothing else here is needed at a call site.
//
// FOR A RECIPIENT WITH NO ACCOUNT (#128's `allowlist.invitation`), the entry
// point is `notifyAddress(eventKey, email, data)`. It is not a bypass: it
// resolves the address to an account when there is one — so a real user's
// preferences are never skipped — and otherwise dispatches through the same
// gate with empty preferences, which the sparse absent-key contract already
// defines as "use the event's default".
//
// WHAT IS DELIBERATELY NOT EXPORTED: `NotificationDeliveryService`, the two
// channel classes, `NotificationStoreService` and `NotificationStreamService`.
// The preference gate and the `mandatory` override live in
// `NotificationsService.dispatch`; a caller able to invoke a channel directly,
// to write a delivery record for a send that never happened, or to push
// straight into a user's open tabs with no durable row behind it, would be a
// route around the one gate this epic has. `NotificationStoreService` is
// withheld for a second reason — it is the per-user read path, and an
// unscoped consumer of it is an IDOR. The module does not export any of them
// either; this barrel and the module agree on purpose.
//
// #128 filled `EVENT_EMAIL_TEMPLATES` and `EVENT_BROWSER_TEMPLATES` and wired
// the three real triggers — user creation in `AuthService.handleGoogleLogin`,
// `AllowlistService.addEmail`, and `UsersService.updateUserRoles` — which
// closes epic #109. Adding the next notification is three steps and is written
// up under "Adding a notification" in the repository's CLAUDE.md.
// =============================================================================

export {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  findEvent,
  channelsFor,
  supportsChannel,
  isMandatory,
} from './notification-events';

export { NotificationsController } from './notifications.controller';
export { NotificationsModule } from './notifications.module';
export { NotificationsService } from './notifications.service';
export { notificationEventSchema } from './dto/notification-event.dto';

// Notification centre wire schemas (#127). Exported for the same reason the
// event schema is: a test, or a later consumer, should assert against the
// schema the endpoint actually validates and documents rather than a
// hand-written copy of its shape.
export {
  notificationListQuerySchema,
  notificationSchema,
  unreadCountSchema,
} from './dto/notification.dto';

// Preference resolution (#125). Pure functions, exported because #126's
// preferences page needs to render the SAME answer the dispatcher will act on
// — a page that computed "enabled" its own way would show a user a state the
// dispatcher disagrees with, and `mandatory` is one of the things it would get
// to disagree about.
export {
  NOTIFICATION_PREFERENCES_NAMESPACE,
  isChannelEnabled,
  readNotificationPreferences,
  resolveChannels,
} from './notification-preferences';

// Admin policy resolution (#226, epic #215). Pure functions, exported for the
// same reason the preference ones are — and one more: `policyChannels` is the
// single definition of "capability ∩ policy", called by both the dispatcher and
// `GET /api/notifications/events`. A second implementation of that intersection
// anywhere is a matrix and a delivery path that can disagree.
export {
  DEFAULT_NOTIFICATION_POLICY,
  isBrowserToastAllowed,
  policyChannels,
} from './notification-policy';
export type { NotificationPolicy } from './notification-policy';
export { notificationConfigSchema } from './dto/notification-config.dto';
export type { NotificationConfigResponse } from './dto/notification-config.dto';

// The DI token, exported so a channel added later (#127) can be registered
// from its own module if it ever needs to live in one.
export { NOTIFICATION_CHANNEL_SENDERS } from './notification.types';

export type {
  NotificationChannel,
  NotificationEventDef,
} from './notification-events';
export type { NotificationEventResponse } from './dto/notification-event.dto';
export type {
  ChannelPreferences,
  NotificationPreferences,
} from './notification-preferences';
export type {
  ChannelDeliveryResult,
  NotificationChannelSender,
  NotificationDispatchContext,
  NotificationRecipient,
} from './notification.types';

export type {
  NotificationListResponse,
  NotificationResponse,
  UnreadCountResponse,
} from './dto/notification.dto';

// The browser channel's template contract (#127). Exported as TYPES ONLY —
// #128 needs these to write the renderers it registers in
// `EVENT_BROWSER_TEMPLATES`, and nothing outside the channel needs the class
// or the map itself.
export type {
  BrowserNotificationContent,
  BrowserNotificationTemplate,
} from './channels/browser-notification.channel';

// The live-stream payload and its SSE event name (#127). The web client needs
// both — the shape it parses, and the string it passes to
// `addEventListener` — and a duplicated event-name literal on the client is a
// stream that silently delivers nothing after a server-side rename.
export {
  HEARTBEAT_INTERVAL_MS,
  NOTIFICATION_SSE_EVENT,
} from './notification-stream.service';
export type { NotificationStreamEvent } from './notification-stream.service';

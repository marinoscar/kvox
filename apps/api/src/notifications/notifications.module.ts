import { Module } from '@nestjs/common';

import { CredentialsModule } from '../credentials/credentials.module';
import { EmailModule } from '../email/email.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';
import { BrowserNotificationChannel } from './channels/browser-notification.channel';
import { EmailNotificationChannel } from './channels/email-notification.channel';
import { PushNotificationChannel } from './channels/push-notification.channel';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationPolicyService } from './notification-policy.service';
import { NotificationStoreService } from './notification-store.service';
import { NotificationStreamService } from './notification-stream.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { JobFailureNotifier } from './ops/job-failure-notifier';
import { PushConfigController } from './push-config.controller';
import { PushConfigService } from './push-config.service';
import { PushSubscriptionService } from './push-subscription.service';
import {
  NOTIFICATION_CHANNEL_SENDERS,
  type NotificationChannelSender,
} from './notification.types';

// =============================================================================
// NotificationsModule (issues #121/#124/#125, epic #109)
// =============================================================================
//
// #121 shipped the registry as pure data with no module. #124 added the one
// endpoint that serves it. #125 added what the epic was actually for: the
// dispatcher, the channel abstraction, and the delivery records. #127 adds the
// browser channel and everything under it — the durable `notifications` store,
// the SSE transport, and the notification centre's endpoints.
//
// -----------------------------------------------------------------------------
// THE CHANNEL LIST IS A FACTORY, AND THAT IS THE EXTENSION POINT
// -----------------------------------------------------------------------------
//
// `NotificationsService` does not inject `EmailNotificationChannel`. It
// injects an ARRAY under `NOTIFICATION_CHANNEL_SENDERS` and iterates whatever
// is in it. So adding #127's browser channel is:
//
//   1. a class implementing `NotificationChannelSender`
//   2. its name in the `inject` list and its parameter in the factory below
//
// and NOTHING in the dispatcher changes. Had the dispatcher taken each channel
// as a constructor parameter, step 2 would have been an edit to the dispatcher
// — and then to its every test's construction — which is the "adding a channel
// is a rewrite" outcome #125 asks to avoid.
//
// THE FACTORY IS EXPLICIT, NOT DISCOVERED. Nest can enumerate providers by
// metadata (`DiscoveryService`), and that would let a channel register itself
// merely by existing. Rejected: "which transports can this app deliver over?"
// would then have no answer readable in a file, and a channel added by an
// import side effect is a channel that appears in production without appearing
// in a diff. This list is short, it is reviewed, and it is the point.
//
// #125 SHIPPED NO BROWSER STUB, and #127 is the payoff: registering
// `BrowserNotificationChannel` below is the entire wiring change. Nothing in
// `NotificationsService` was touched to add a second transport, which is what
// the array-under-a-token indirection above was for.
//
// -----------------------------------------------------------------------------
// `PushNotificationChannel` IS NOW ALWAYS REGISTERED, LIKE EVERY OTHER
// CHANNEL — SEE #355 FOR WHY THAT CHANGED
// -----------------------------------------------------------------------------
//
// Until #355, this factory registered `PushNotificationChannel` only when
// `PushSubscriptionService.isEnabled()` was true AT BOOT, because Web Push
// required a VAPID key pair set as an env var this deployment might never
// have generated — and registering the channel anyway would make
// `NotificationsService.resolveChannels` see `push` as an available sender
// for any event that declares it, write a `queued` `notification_deliveries`
// row, and then fail that row on every single attempt, forever, for every
// user, on a deployment that simply never turned Web Push on. A permanently
// red delivery record for a feature that was never supposed to be live.
//
// #355 REMOVES THE PREMISE THAT MADE THAT THE RIGHT CALL: Web Push
// configuration is now admin-UI-configurable at runtime, through
// `PushConfigController`/`PushConfigService` above, with generate/rotate/
// enable/disable/remove — a real, in-app remedy for "this channel is
// unconfigured" that did not exist when the conditional above was written.
// So `push` now follows the SAME pattern `email`/`browser` already do:
// unconditional registration, with `PushNotificationChannel`'s existing
// defensive guard (empty keys -> `{ success: false, error }`, now backed by
// `PushConfigService.resolveActiveVapidConfig()` instead of a raw
// `ConfigService.get`) as the real, always-live gate. This matches
// `EmailModule`'s own documented precedent (see `email.module.ts:31-39`):
// an unconfigured channel produces an honest, admin-actionable FAILED
// delivery row — something an operator can see and fix from the Push
// Configuration settings page — rather than the channel not existing at all.
//
// `PushSubscriptionService.isEnabled()` is STILL the gate for whether a
// browser may SUBSCRIBE (`POST /notifications/push/subscriptions` still 409s
// on a deployment with no active VAPID config) — that question did not
// change, only whether an unconfigured deployment's failed push deliveries
// are visible or silently absent.
//
// -----------------------------------------------------------------------------
// WHY `NotificationStreamService` IS A PROVIDER AND NOT EXPORTED (#127)
// -----------------------------------------------------------------------------
//
// It is shared state — a process-wide map of open connections — so it must be
// a singleton, which is what a module provider gives. It is NOT exported,
// because a feature able to call `publish` directly could push an arbitrary
// payload to a user's open tabs while writing no `notifications` row and no
// `notification_deliveries` row: a notification with no durable record, no
// preference check, and no `mandatory` gate. The ONLY caller is
// `BrowserNotificationChannel`, which is reached through the dispatcher, which
// is where the gate lives. Same reasoning as #125's refusal to export
// `NotificationDeliveryService`.
//
// `NotificationStoreService` is likewise internal: it is the controller's
// backing store for the caller's OWN rows, and every method takes a user id it
// filters on. Exporting it would put a "read any user's notifications" API one
// import away from any module that wanted one.
// =============================================================================

@Module({
  imports: [
    // The dispatcher reads `users` (for the recipient address) and
    // `user_settings` (for preferences), and the delivery service writes
    // `notification_deliveries`.
    PrismaModule,
    // Transports and email configuration for the one implemented channel.
    // Imported explicitly because EmailModule is deliberately not @Global —
    // it can reach a plaintext-returning credential service, so every consumer
    // shows up in a diff.
    EmailModule,
    // The deployment-wide browser-notification policy (#226), read through
    // `SystemSettingsService`. The dependency runs one way only —
    // notifications depend on settings, settings depend on nothing here — so
    // there is no cycle to forward-ref around, and reusing that service means
    // the dispatcher degrades a malformed `system_settings` row exactly as the
    // admin API does instead of re-deriving those rules.
    SettingsModule,
    // The VAPID private key's only home (#355). Imported explicitly, exactly
    // like `EmailModule` above and for the identical reason: `CredentialsModule`
    // is deliberately not `@Global()` because it can reach a plaintext-returning
    // service (`CredentialsService.getSecret`), so every consumer of it shows
    // up in a diff. `PushConfigService` is the consumer here.
    CredentialsModule,
  ],
  controllers: [NotificationsController, PushConfigController],
  providers: [
    NotificationsService,
    NotificationDeliveryService,
    // NOT EXPORTED, like the store and the stream. It is a read-only view of an
    // admin setting, so exporting it would leak nothing — but a second consumer
    // reading the policy is a second place that could act on it, and #226's
    // whole point is that the policy is interpreted in exactly one file.
    NotificationPolicyService,
    NotificationStoreService,
    NotificationStreamService,
    // NOT EXPORTED, same reasoning as the three above: #229's subscribe/
    // unsubscribe endpoints are the only legitimate way to write or remove a
    // `push_subscriptions` row, and the push channel reaches these rows through
    // Prisma directly (it reads, it does not subscribe/unsubscribe on anyone's
    // behalf) rather than through this service. `isEnabled()`/
    // `getVapidPublicKey()` now delegate to `PushConfigService
    // .resolveActiveVapidConfig()` (#355) — see that file for the full
    // env/DB precedence — rather than reading `ConfigService` directly.
    PushSubscriptionService,
    // The runtime-configurable Web Push admin surface (#355): generate,
    // rotate, enable/disable, and remove a VAPID key pair with no restart.
    // Both `PushSubscriptionService` and `PushNotificationChannel` inject it
    // for `resolveActiveVapidConfig()` — the one place the env/DB precedence
    // is implemented (see that method's own header) — and it is EXPORTED, in
    // case a future feature outside this module (an ops dashboard, a health
    // check) needs to read the same "is push actually active" answer.
    PushConfigService,
    EmailNotificationChannel,
    BrowserNotificationChannel,
    // #288's queue listener (epic #254). A PROVIDER AND NOT AN EXPORT, and it
    // lives on THIS side of the seam deliberately: it subscribes to
    // `job.settled` through the global `EventEmitter2` rather than being called
    // by `JobsModule`, so the queue keeps no dependency on notifications and
    // this module keeps none on the queue. See the file's own header for why a
    // listener rather than a `notify()` inside `JobTerminalService`.
    JobFailureNotifier,
    PushNotificationChannel,
    {
      provide: NOTIFICATION_CHANNEL_SENDERS,
      useFactory: (
        email: EmailNotificationChannel,
        browser: BrowserNotificationChannel,
        push: PushNotificationChannel,
      ): NotificationChannelSender[] => [email, browser, push],
      inject: [
        EmailNotificationChannel,
        BrowserNotificationChannel,
        PushNotificationChannel,
      ],
    },
  ],
  // `NotificationsService` and `PushConfigService` are exported.
  // `NotificationDeliveryService`, the store, the stream and the channels stay
  // internal: a feature that wants to notify someone calls `notify`, and must
  // not be able to write a delivery record for a send that did not happen,
  // push to a user's open tabs without a durable row, or reach past the
  // preference gate by invoking a channel directly. That gate is only a gate
  // if there is no way around it. `PushConfigService` is different in kind —
  // it is the admin configuration surface itself, not a delivery internal — so
  // it is exported like `NotificationsService`.
  exports: [NotificationsService, PushConfigService],
})
export class NotificationsModule {}

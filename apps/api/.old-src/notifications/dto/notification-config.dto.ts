import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/notifications/config — response (issue #226, epic #215)
// =============================================================================
//
// What the CLIENT needs to know about this deployment's notification
// capabilities, and nothing else.
//
// -----------------------------------------------------------------------------
// WHY THIS ENDPOINT EXISTS INSTEAD OF WIDENING `system_settings:read`
// -----------------------------------------------------------------------------
//
// #225 stores the browser-notification policy in system settings, and
// `GET /api/system-settings` is gated on `system_settings:read` — a permission
// the seeded `viewer` and `contributor` roles do not hold (see
// `prisma/seed.ts`, `ROLE_PERMISSIONS`: they hold `user_settings:read|write`
// and `storage:read`). So the users the policy AFFECTS are precisely the users
// who cannot read it.
//
// REJECTED — granting `system_settings:read` to `viewer`. It is one seed line
// and it is the wrong line. That permission returns the WHOLE settings blob —
// job, fleet, backup and maintenance policy, plus anything a fork adds to it —
// so all of that would become readable by every account the day someone
// wanted a browser notification to behave. A capability probe should hand out the capability,
// not the configuration behind it.
//
// So: a narrow, purpose-built projection, readable by any authenticated user,
// carrying three booleans-worth of information and no policy detail. In
// particular it does NOT expose `disabledEvents` — which events an operator has
// muted is not something a client needs (the per-event answer arrives with the
// event, as the stream's `toast` flag) and it is a small map of what this
// deployment considers noisy.
// =============================================================================

export const notificationConfigSchema = z.object({
  /**
   * May this client raise browser notifications at all?
   *
   * THE PERMISSION-PROMPT GATE. A client asks the browser for Notification
   * permission only when this is `true`. Browser permission, once denied, is
   * effectively permanent and cannot be re-prompted, so prompting while the
   * capability is switched off spends a one-shot user decision on a feature
   * this deployment does not offer.
   *
   * NOT A DELIVERY GATE. `false` does not mean notifications stop: rows are
   * still written and the notification centre still fills. It means the OS
   * bubble is off. Per-event suppression is not visible here — it arrives with
   * each notification as `toast` on the stream, so a client cannot go stale on
   * it.
   */
  browserEnabled: z.boolean(),

  /**
   * May this client subscribe to Web Push?
   *
   * `true` exactly when THIS DEPLOYMENT has an ACTIVE VAPID key pair right
   * now — an admin-configured one saved through `/admin/push-config` and
   * enabled, or, absent one, the `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` env
   * vars (see `PushConfigService.resolveActiveVapidConfig`, #355, for the
   * full precedence; `PushSubscriptionService.isEnabled` is the one-line
   * delegation this field is built from). It says nothing about whether the
   * CALLER has subscribed; a client asks the browser for permission and
   * calls `pushManager.subscribe` only when this is `true`, then posts the
   * result to `POST /api/notifications/push/subscriptions`.
   *
   * NOT A DELIVERY GUARANTEE. This deployment can accept and store a
   * subscription the moment this is `true`; whether any given send actually
   * reaches a device still depends on that subscription staying valid at
   * `PushNotificationChannel`'s next delivery. A `true` here is "you may
   * subscribe", not "you will be sent anything".
   */
  pushEnabled: z.boolean(),

  /**
   * The VAPID application server key a client needs to call
   * `pushManager.subscribe`, or `null` when `pushEnabled` is `false`.
   *
   * Mirrors `pushEnabled`: non-null exactly when an active key pair exists —
   * see that field's note for the admin-configured-or-env precedence. It is a
   * PUBLIC key by definition — it is handed to every browser that subscribes
   * — so returning it here to any authenticated user gives nothing away; the
   * private half never leaves the server (it lives in the encrypted
   * credential store, read only by `PushConfigService.resolveActiveVapidConfig`
   * at the moment `PushNotificationChannel` signs a push).
   */
  vapidPublicKey: z.string().nullable(),
});

/** The client-facing notification capabilities of this deployment. */
export type NotificationConfigResponse = z.infer<
  typeof notificationConfigSchema
>;

export class NotificationConfigDto extends createZodDto(
  notificationConfigSchema,
) {}

import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationsService,
  findEvent,
  registerNotification,
  type NotificationChannel,
  type NotificationRegistration,
} from '@marinoscar/platform-api/notifications';
import type { KvoxNotificationEventDef, KvoxNotifyPort } from '@marinoscar/kvox-api/ports';

// =============================================================================
// PlatformKvoxNotifyAdapter: the `KVOX_NOTIFY` port over the platform
// notifications slice (issue #490, epic #486)
// =============================================================================
//
// `notify` is DETACHED: it starts the platform dispatch and returns before it
// finishes, and a failure is logged, never thrown, so a broken channel cannot fail
// the work that raised the event. Call it after the triggering write has committed,
// never inside a `$transaction`.
//
// `registerEvents` is `registerNotification` (event + email template + browser
// renderer, atomic). The platform's registry freezes when the application is created,
// and this app registers its events at import time (`notifications-registry/`), so by
// the time a slice calls this the key is normally known: a known key is skipped. A key
// that is new AFTER the freeze is refused by the registry with a clear `FROZEN` error;
// the event must be declared at import time. Event keys, channel ids and template names
// are persisted: never rename one.
// =============================================================================

@Injectable()
export class PlatformKvoxNotifyAdapter implements KvoxNotifyPort {
  private readonly logger = new Logger(PlatformKvoxNotifyAdapter.name);

  constructor(private readonly notifications: NotificationsService) {}

  registerEvents(defs: KvoxNotificationEventDef[]): void {
    for (const def of defs) {
      if (findEvent(def.key)) continue;

      const registration: NotificationRegistration = {
        event: {
          key: def.key,
          label: def.label,
          description: def.description,
          channels: [...def.channels] as NotificationChannel[],
          defaultEnabled: def.defaultEnabled ?? true,
          ...(def.mandatory !== undefined ? { mandatory: def.mandatory } : {}),
        },
        ...(def.emailTemplate !== undefined ? { emailTemplate: def.emailTemplate } : {}),
        ...(def.browserTemplate !== undefined ? { browserTemplate: def.browserTemplate } : {}),
      };
      registerNotification(registration);
    }
  }

  notify(eventKey: string, userId: string, data: unknown): void {
    try {
      void this.notifications.notify(eventKey, userId, data).catch((error: unknown) => {
        this.logger.warn(`Notification ${eventKey} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } catch (error) {
      this.logger.warn(`Notification ${eventKey} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

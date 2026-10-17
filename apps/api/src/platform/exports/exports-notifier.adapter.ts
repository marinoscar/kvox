import { Injectable } from '@nestjs/common';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import type { ExportNotificationData, ExportsNotifier } from '@marinoscar/platform-api/exports';

/**
 * The exports slice's `EXPORTS_NOTIFIER` over the platform dispatcher (issue #532).
 *
 * The slice calls it AFTER the export file is stored (or the last attempt failed) and outside
 * any transaction; `NotificationsService.notify` never rejects, and the data is passed through
 * untouched: ids and labels, never a URL, a file name or a value. The two events have no email,
 * so nothing here needs the application URL.
 */
@Injectable()
export class ExportsNotifierAdapter implements ExportsNotifier {
  constructor(private readonly notifications: NotificationsService) {}

  async notify(eventKey: string, userId: string, data: ExportNotificationData): Promise<void> {
    await this.notifications.notify(eventKey, userId, data);
  }
}

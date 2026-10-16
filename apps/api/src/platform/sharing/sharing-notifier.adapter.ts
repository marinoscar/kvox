import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import { SHARED_WITH_YOU_EVENT_KEY } from '@marinoscar/platform-api/sharing';
import type { SharingNotifier } from '@marinoscar/platform-api/sharing';

/**
 * A demotion of a transcript share (editor to viewer) is SILENT, as it was under
 * `transcripts.transcript_shared`: "X shared Y with you" is simply the wrong
 * message for "you can no longer correct this". Revocation never notified either.
 */
function isTranscriptDemotion(eventKey: string, data: unknown): boolean {
  if (eventKey !== SHARED_WITH_YOU_EVENT_KEY || typeof data !== 'object' || data === null) return false;

  const record = data as { resourceType?: string; role?: string; previousRole?: string };

  return record.resourceType === 'transcript' && record.previousRole === 'editor' && record.role === 'viewer';
}

/**
 * The sharing slice's `SHARING_NOTIFIER` over the platform dispatcher (issue #485).
 *
 * The slice calls it AFTER the grant's transaction committed and outside it, and
 * `NotificationsService.notify*` never rejects. For `sharing.shared_with_you` the
 * app adds what the slice leaves to it: the absolute URL of the record (from the
 * type's `describe().path`) and the sign-in URL, both rooted at `APP_URL`. An
 * event nobody registered (`groups.invitation`: this app has no groups UI yet) is
 * ignored by the dispatcher.
 */
@Injectable()
export class SharingNotifierAdapter implements SharingNotifier {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  async notify(eventKey: string, userId: string, data: unknown): Promise<void> {
    if (isTranscriptDemotion(eventKey, data)) return;

    await this.notifications.notify(eventKey, userId, this.withUrls(eventKey, data));
  }

  async notifyAddress(eventKey: string, email: string, data: unknown): Promise<void> {
    await this.notifications.notifyAddress(eventKey, email, this.withUrls(eventKey, data));
  }

  private withUrls(eventKey: string, data: unknown): unknown {
    if (eventKey !== SHARED_WITH_YOU_EVENT_KEY || typeof data !== 'object' || data === null) return data;

    const appUrl = this.appUrl();
    if (!appUrl) return data;

    const record = data as { path?: string };
    return {
      ...data,
      ...(typeof record.path === 'string' && record.path.startsWith('/')
        ? { openUrl: `${appUrl}${record.path}` }
        : {}),
      signInUrl: appUrl,
    };
  }

  /** The application root, without a trailing slash, or undefined when unset. */
  private appUrl(): string | undefined {
    const appUrl = this.config.get<string>('appUrl');

    return appUrl ? appUrl.replace(/\/+$/, '') : undefined;
  }
}

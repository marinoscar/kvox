// =============================================================================
// The exports slice's notifications (issue #532, epic #479)
// =============================================================================
//
// `export.ready` and `export.failed`, raised by the platform's export job AFTER
// the file is stored (or the last attempt failed), outside any transaction, through
// `ExportsNotifierAdapter` (`platform/exports/`). Channels are the in-app bell and
// Web Push only: the platform carries ids and labels, never a URL, a file name or a
// value, and both link to the "Download your data" page (`DATA_EXPORT_PAGE_PATH`),
// where the signed download is minted on demand.
//
// The event definitions and both browser renderers are the platform's. Neither has an
// email: a download link must not sit in a mailbox. Not `mandatory`: a user may mute
// them like any other bell notification.
// =============================================================================

import {
  EXPORT_FAILED_EVENT,
  EXPORT_READY_EVENT,
  exportFailedBrowserTemplate,
  exportReadyBrowserTemplate,
} from '@marinoscar/platform-api/exports';
import type { NotificationRegistration } from '@marinoscar/platform-api/notifications';

export const EXPORTS_NOTIFICATIONS: readonly NotificationRegistration[] = [
  {
    event: { ...EXPORT_READY_EVENT, channels: [...EXPORT_READY_EVENT.channels] },
    browserTemplate: (data: never) => exportReadyBrowserTemplate(data),
  },
  {
    event: { ...EXPORT_FAILED_EVENT, channels: [...EXPORT_FAILED_EVENT.channels] },
    browserTemplate: (data: never) => exportFailedBrowserTemplate(data),
  },
];

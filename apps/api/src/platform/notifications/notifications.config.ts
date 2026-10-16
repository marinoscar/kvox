// =============================================================================
// The notifications slice's composition (issue #470, epic #467)
// =============================================================================
//
// `NotificationsModule.forRoot` is GLOBAL and serves `/api/notifications/*`
// (inbox, SSE stream, Web Push subscriptions, `config`, `events`),
// `/api/admin/push-config/*` (`push:*`, including `POST test`), the dispatcher
// (`NotificationsService`), the three platform channels (email, browser, push),
// the VAPID Doctor check, the `jobs.job_failed` and `nodes.node_offline`
// notifiers, and the notification retention jobs. `BroadcastsModule` serves
// `/api/admin/broadcasts/*` (`broadcasts:*`) and the `admin.broadcast.start` and
// `admin.broadcast.chunk` job handlers (type strings unchanged). They replace
// this app's own `notifications/` folder.
//
// The registries (`./notification.manifest`) are filled BEFORE `forRoot`
// composes. Web Push is configured at RUNTIME (`/admin/settings/push`, the
// private key in the credential store under purpose `push_vapid`, the string
// this app has always stored); there is no environment variable.
//
// A module that needs `NotificationsService` imports nothing: the slice is
// global.
// =============================================================================

import { BroadcastsModule, NotificationsModule } from '@marinoscar/platform-api/notifications';

import './notification.manifest';
import { emailModule } from '../email/email.config';
import { NotificationsHostModule } from './notifications-host.module';

export const notificationsModule = NotificationsModule.forRoot({
  imports: [emailModule, NotificationsHostModule],
});

export { BroadcastsModule };

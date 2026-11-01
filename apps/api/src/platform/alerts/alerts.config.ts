import { Module } from '@nestjs/common';
import { ALERTS_WEBHOOK_EMITTER, AlertsModule as PlatformAlertsModule } from '@marinoscar/platform-api/alerts';

import { jobsModule } from '../jobs/jobs.config';
import { telemetryModule } from '../telemetry/telemetry.config';
import { webhooksModule } from '../webhooks/webhooks.config';
import { AlertsWebhookAdapter, registerAlertWebhookEvents } from './alerts-webhooks.adapter';

// =============================================================================
// The alerts slice, as this app binds it (#795)
// =============================================================================
//
// Rules over telemetry metrics, worker-node events and fleet health, incidents
// and their notifications, under `/api/admin/alerts`. The manifest half lives
// where the other slices' does: the two email templates and the two events in
// `platform/notifications/notification.manifest.ts`, the permissions in the
// platform manifest (`registerPlatformPermissions`, `app-registrations/`).
//
// The telemetry module is imported so the metric and verdict kinds can read the
// store. The optional webhook port (`ALERTS_WEBHOOK_EMITTER`) is bound to the
// webhooks slice through `AlertsWebhookAdapter` (`alerts-webhooks.adapter.ts`),
// which also registers the `alerts.alert.fired` and `alerts.alert.resolved`
// events in the webhooks catalog.
// =============================================================================

registerAlertWebhookEvents();

/** Binds the alerts webhook port to `WebhooksService.emit`. */
@Module({
  imports: [webhooksModule],
  providers: [AlertsWebhookAdapter, { provide: ALERTS_WEBHOOK_EMITTER, useExisting: AlertsWebhookAdapter }],
  exports: [ALERTS_WEBHOOK_EMITTER],
})
export class AlertsWebhooksHostModule {}

/** The slice, mounted once in AppModule. */
export const alertsModule = PlatformAlertsModule.forRoot({ imports: [jobsModule, telemetryModule, AlertsWebhooksHostModule] });

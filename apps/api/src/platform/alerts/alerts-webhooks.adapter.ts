// =============================================================================
// The app's binding of the alerts slice's optional webhook port (#795)
// =============================================================================
//
// `ALERTS_WEBHOOK_EMITTER` is bound to `WebhooksService.emit` (#1046). The
// adapter only passes the event on: `emit` validates the data, records one
// delivery row per subscribed endpoint and enqueues the delivery jobs, and never
// calls a receiver itself, so a slow or failing receiver cannot hold up (or roll
// back) an incident. Both events are `system`-audience (`orgId: null`): only the
// deployment's endpoints receive them, and an endpoint's owner must hold the
// webhooks slice's `system_webhooks:read` permission.
// =============================================================================

import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ALERT_WEBHOOK_EVENTS, alertWebhookDataSchema } from '@marinoscar/platform-contract/alerts';
import type { AlertsWebhookEmitter } from '@marinoscar/platform-api/alerts';
import { SYSTEM_WEBHOOKS_PERMISSIONS, WebhooksService, registerWebhookEvent } from '@marinoscar/platform-api/webhooks';

const example: z.infer<typeof alertWebhookDataSchema> = {
  incidentId: '00000000-0000-4000-8000-000000000001',
  rule: { id: '00000000-0000-4000-8000-000000000002', key: null, name: 'Example rule', kind: 'metric_threshold', severity: 'warning' },
  labels: { node: 'node-1' },
  value: 91.5,
  summary: 'Example rule: 91.5 is above 90',
  firedAt: '2026-11-01T10:00:00.000Z',
  resolvedAt: null,
};

/** The alert webhook events, registered into the webhooks catalog (idempotent). Called at import time by `alerts.config.ts`: the registry freezes at bootstrap. */
export function registerAlertWebhookEvents(): void {
  registerWebhookEvent({
    key: ALERT_WEBHOOK_EVENTS.FIRED,
    label: 'Alert fired',
    description: 'An alert rule started firing.',
    group: 'Alerts',
    audience: 'system',
    permission: SYSTEM_WEBHOOKS_PERMISSIONS.SYSTEM_WEBHOOKS_READ.id,
    payloadSchema: alertWebhookDataSchema,
    example,
    source: 'alerts',
  });
  registerWebhookEvent({
    key: ALERT_WEBHOOK_EVENTS.RESOLVED,
    label: 'Alert resolved',
    description: 'A firing alert cleared.',
    group: 'Alerts',
    audience: 'system',
    permission: SYSTEM_WEBHOOKS_PERMISSIONS.SYSTEM_WEBHOOKS_READ.id,
    payloadSchema: alertWebhookDataSchema,
    example: { ...example, resolvedAt: '2026-11-01T10:30:00.000Z' },
    source: 'alerts',
  });
}

/** `AlertsWebhookEmitter` over `WebhooksService.emit`. */
@Injectable()
export class AlertsWebhookAdapter implements AlertsWebhookEmitter {
  constructor(private readonly webhooks: WebhooksService) {}

  async emit(eventKey: string, data: Record<string, unknown>, ctx: { orgId: string | null }): Promise<void> {
    await this.webhooks.emit(eventKey, data, { orgId: ctx.orgId });
  }
}

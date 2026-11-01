import { KVOX_WEBHOOK_EVENTS } from '@marinoscar/kvox-api/webhooks';
import { registerWebhookEvent } from '@marinoscar/platform-api/webhooks';

// =============================================================================
// KVox's webhook events, registered with the platform webhooks catalog (#795)
// =============================================================================
//
// Each entry of `KVOX_WEBHOOK_EVENTS` (pure data in `@marinoscar/kvox-api/webhooks`) becomes a
// `registerWebhookEvent` call, plus the one thing the package leaves to the host: the permission
// the endpoint's owner must hold to receive it. They are the same strings the read routes of the
// slice enforce (`graph:read`, `notes:read`, `transcripts:read`), so an owner who loses the
// permission stops receiving the event at the next fan-out.
//
// REGISTERED AT IMPORT TIME: the registry freezes when the application bootstraps. Idempotent
// per process (a second registration of one key is a `DUPLICATE_ID` error). An event key is
// persisted in every subscription: never rename one.
// =============================================================================

/** The permission the owner of an endpoint must hold to receive each KVox event, by group. */
const PERMISSION_BY_GROUP: Readonly<Record<string, string>> = {
  Graph: 'graph:read',
  Notes: 'notes:read',
  Transcripts: 'transcripts:read',
};

let registered = false;

/** Registers the KVox webhook events. Idempotent per process. */
export function registerKvoxWebhookEvents(): void {
  if (registered) return;
  registered = true;

  for (const event of KVOX_WEBHOOK_EVENTS) {
    const permission = PERMISSION_BY_GROUP[event.group];
    if (!permission) throw new Error(`KVox webhook event ${event.key} has no permission for group "${event.group}"`);
    registerWebhookEvent({ ...event, permission, source: 'kvox' });
  }
}

import { Module, type DynamicModule } from '@nestjs/common';

import { WebhookEmitHandler } from './webhook-emit.handler.js';
import { WebhookEventsListener } from './webhook-events.listener.js';

/**
 * The webhooks slice: four listeners that enqueue `kvox.webhook_emit`, and its handler, which
 * publishes through `KVOX_WEBHOOKS`. Optional; a host that never imports it publishes nothing.
 * The ports are global (`KvoxPortsModule`), so it imports nothing; with no `webhooks` binding the
 * port is a no-op.
 *
 * @example
 * ```ts
 * KvoxWebhooksModule.forRoot()
 * ```
 *
 * @extensionPoint module
 * @stability experimental
 */
@Module({})
export class KvoxWebhooksModule {
  /**
   * Builds the module.
   *
   * @returns the dynamic module.
   */
  static forRoot(): DynamicModule {
    return {
      module: KvoxWebhooksModule,
      providers: [WebhookEventsListener, WebhookEmitHandler],
    };
  }
}

// =============================================================================
// The notifications slice's host ports (issue #470, epic #467)
// =============================================================================
//
//   NOTIFICATIONS_EVENT_BUS -> EVENT_BUS            (the host core's cross-replica bus,
//                                                    so an SSE row reaches a tab held by
//                                                    another replica)
//   NOTIFICATIONS_METRICS   -> AppMetricsService    (`app.notifications.deliveries`)
//
// `@Global()` so the slice's services resolve the ports from whichever module
// instantiates them. The bus and the metrics are the host core's (#464).
// =============================================================================

import { Global, Module } from '@nestjs/common';
import { AppMetricsService, EVENT_BUS, exceedsEventBusPayloadLimit } from '@marinoscar/platform-api/host';
import type { EventBus } from '@marinoscar/platform-api/host';
import {
  NOTIFICATIONS_EVENT_BUS,
  NOTIFICATIONS_METRICS,
} from '@marinoscar/platform-api/notifications';
import type { NotificationsEventBus } from '@marinoscar/platform-api/notifications';

@Global()
@Module({
  providers: [
    {
      provide: NOTIFICATIONS_EVENT_BUS,
      inject: [EVENT_BUS],
      useFactory: (bus: EventBus): NotificationsEventBus => ({
        publish: (channel, payload) => bus.publish(channel, payload),
        subscribe: (channel, handler) => bus.subscribe(channel, handler),
        exceedsPayloadLimit: exceedsEventBusPayloadLimit,
      }),
    },
    { provide: NOTIFICATIONS_METRICS, useExisting: AppMetricsService },
  ],
  exports: [NOTIFICATIONS_EVENT_BUS, NOTIFICATIONS_METRICS],
})
export class NotificationsHostModule {}

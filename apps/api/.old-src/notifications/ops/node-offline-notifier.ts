import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { NODE_OFFLINE_EVENT, type NodeOfflineEvent } from '@marinoscar/platform-api/nodes';

import { PERMISSIONS } from '../../common/constants/roles.constants';
import type { NodeOfflineEmailData } from '../../email';
import { describeThrown } from '../describe-thrown';
import { NotificationsService } from '../notifications.service';

/**
 * Raises `nodes.node_offline` for each worker node the platform's fleet sweep
 * marks offline.
 *
 * PLATFORM-ADOPTION-SHIM(2.3): the platform's fleet sweep (issue #468) announces
 * a node going offline as a `NODE_OFFLINE_EVENT`; the platform notifications
 * slice has the listener that turns it into this notification, and issue #470
 * adopts that slice. Until then this app's own notification registry owns the
 * `nodes.node_offline` event, so this listener does what the local sweep handler
 * used to do inline. Delete the file with that adoption.
 *
 * Like the other `@OnEvent` bodies it is one dispatch: the audience query and
 * every send run detached inside `notifyPermissionHolders`, and nothing here
 * throws. The audience is `nodes:read`, the string the admin nodes controller
 * enforces.
 */
@Injectable()
export class NodeOfflineNotifier {
  private readonly logger = new Logger(NodeOfflineNotifier.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  @OnEvent(NODE_OFFLINE_EVENT)
  handleNodeOffline(event: NodeOfflineEvent): void {
    try {
      // Annotated with the template's own type: `notifyPermissionHolders` takes
      // `data: unknown`, so this is the only place the payload shape is checked.
      const payload: NodeOfflineEmailData = {
        nodeId: event.nodeId,
        nodeName: event.nodeName,
        lastHeartbeatAt: event.lastHeartbeatAt,
        markedOfflineAt: event.markedOfflineAt,
        staleAfterMinutes: event.staleAfterMinutes,
        appUrl: this.appUrl(),
      };

      void this.notifications
        .notifyPermissionHolders('nodes.node_offline', PERMISSIONS.NODES_READ, payload)
        .catch((error: unknown) => {
          this.logger.error(
            `Dispatching 'nodes.node_offline' for ${event.nodeId} rejected, which the ` +
              `dispatcher contracts never to do: ${describeThrown(error)}`,
          );
        });
    } catch (error) {
      this.logger.error(
        `Could not raise 'nodes.node_offline' for node ${event.nodeId}; the node is still ` +
          `marked offline: ${describeThrown(error)}`,
      );
    }
  }

  /** The application root, trailing slashes trimmed, or `undefined` (the template then omits its CTA). */
  private appUrl(): string | undefined {
    const appUrl = this.config.get<string>('appUrl');
    return appUrl ? appUrl.replace(/\/+$/, '') : undefined;
  }
}

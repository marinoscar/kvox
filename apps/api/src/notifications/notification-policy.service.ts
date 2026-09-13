import { Injectable, Logger } from '@nestjs/common';

import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { describeThrown } from './describe-thrown';
import {
  DEFAULT_NOTIFICATION_POLICY,
  type NotificationPolicy,
} from './notification-policy';

// =============================================================================
// NotificationPolicyService — the Nest side of #226's admin gate
// =============================================================================
//
// Six lines of behaviour and two paragraphs of reason. It fetches
// `system_settings.value.notifications` and hands it to the pure functions in
// `notification-policy.ts`; everything that DECIDES anything lives there, and
// everything that TALKS TO THE DATABASE lives here.
//
// -----------------------------------------------------------------------------
// WHY A SERVICE AT ALL, RATHER THAN INJECTING `SystemSettingsService` DIRECTLY
// -----------------------------------------------------------------------------
//
// Three call sites need this value — the dispatcher, `GET /events` and
// `GET /config` — and two of them are on paths with a hard never-throw
// contract. `notify()` is documented not to reject for ANY reason, so a
// transient database error while reading a settings row must not become an
// unhandled rejection inside a detached dispatch. Putting the try/catch here
// means the guarantee is made once, in the place that owns it, instead of being
// re-made (and eventually forgotten) at each call site.
//
// It also keeps the direction of the dependency legible: notifications depend
// on settings, settings depend on nothing here. `NotificationsModule` imports
// `SettingsModule` and not the reverse.
//
// -----------------------------------------------------------------------------
// NOT CACHED, DELIBERATELY
// -----------------------------------------------------------------------------
//
// One indexed lookup by primary key per dispatch and per request. A cache with
// any TTL would mean an operator flipping the kill switch — plausibly BECAUSE
// something is going wrong right now — waits out the TTL before it takes
// effect, and a control that applies "soon" is not a control. If this ever
// shows up in a profile, the fix is a cache with explicit invalidation on the
// settings write path, not a timer.
// =============================================================================

@Injectable()
export class NotificationPolicyService {
  private readonly logger = new Logger(NotificationPolicyService.name);

  constructor(private readonly systemSettings: SystemSettingsService) {}

  /**
   * The current deployment-wide browser-notification policy.
   *
   * NEVER THROWS AND NEVER RETURNS `undefined`. On any failure it logs and
   * returns {@link DEFAULT_NOTIFICATION_POLICY}, which is permissive — see that
   * constant for why the fallback direction is "allow": a database blip that
   * silenced a mandatory security alert's toast would leave no trace anywhere,
   * whereas a blip that briefly ignores an operator's mute costs one toast and
   * says so in the log.
   */
  async getPolicy(): Promise<NotificationPolicy> {
    try {
      return await this.systemSettings.getNotificationsPolicy();
    } catch (err) {
      this.logger.warn(
        `Could not read the notification policy; falling back to the ` +
          `permissive default: ${describeThrown(err)}`,
      );
      return DEFAULT_NOTIFICATION_POLICY;
    }
  }
}

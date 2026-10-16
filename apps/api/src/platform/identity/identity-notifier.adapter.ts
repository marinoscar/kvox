import { Injectable, Logger } from '@nestjs/common';
import type {
  AllowlistInvitationNotice,
  IdentityNotifier,
  OrgInvitationNotice,
  RoleChangedNotice,
  UserWelcomeNotice,
} from '@marinoscar/platform-api/identity';

import { NotificationsService } from '@marinoscar/platform-api/notifications';

/**
 * Identity's `IDENTITY_NOTIFIER` over the platform's `NotificationsService`
 * (#470). A port bridge: the platform exports no `IdentityNotifier`
 * implementation, so this maps the identity notices onto the events registered
 * in `notifications-registry/identity.notifications.ts`.
 *
 * Identity calls every method AFTER the triggering write committed and outside
 * any transaction, and `NotificationsService.notify*` never rejects (a delivery
 * failure becomes a `notification_deliveries` row), so a mail outage cannot fail
 * a sign-in, a role change or an allowlist insert.
 *
 * Event keys are this app's historical ones, unchanged, so users' stored
 * notification preferences keep applying:
 *   roleChanged         -> `security.role_changed`  (mandatory)
 *   userWelcomed        -> `user.welcome`
 *   allowlistInvitation -> `allowlist.invitation`
 *   orgInvitation       -> logged and dropped (single-organization mode has
 *                          no organization invitations)
 */
@Injectable()
export class IdentityNotifierAdapter implements IdentityNotifier {
  private readonly logger = new Logger(IdentityNotifierAdapter.name);

  constructor(private readonly notifications: NotificationsService) {}

  async roleChanged(userId: string, notice: RoleChangedNotice): Promise<void> {
    await this.notifications.notify('security.role_changed', userId, {
      recipientEmail: notice.recipientEmail,
      previousRoles: notice.previousRoles,
      currentRoles: notice.currentRoles,
      changedAt: notice.changedAt,
      ...(notice.appUrl ? { appUrl: notice.appUrl } : {}),
    });
  }

  async userWelcomed(userId: string, notice: UserWelcomeNotice): Promise<void> {
    await this.notifications.notify('user.welcome', userId, {
      recipientEmail: notice.recipientEmail,
      ...(notice.recipientName ? { recipientName: notice.recipientName } : {}),
      roles: notice.roles,
      ...(notice.appUrl ? { appUrl: notice.appUrl } : {}),
    });
  }

  async allowlistInvitation(email: string, notice: AllowlistInvitationNotice): Promise<void> {
    await this.notifications.notifyAddress('allowlist.invitation', email, {
      recipientEmail: notice.recipientEmail,
      ...(notice.invitedBy ? { invitedBy: notice.invitedBy } : {}),
      ...(notice.signInUrl ? { signInUrl: notice.signInUrl } : {}),
    });
  }

  async orgInvitation(_email: string, notice: OrgInvitationNotice): Promise<void> {
    // Single-organization mode: `feature: 'orgs'` is off and the organization
    // routes are unreachable, so nothing should arrive here. Never log the
    // address; the organization name is enough to find the caller.
    this.logger.debug(
      `Dropping an organization invitation to "${notice.orgName}": this app runs in single-organization mode`,
    );
  }
}

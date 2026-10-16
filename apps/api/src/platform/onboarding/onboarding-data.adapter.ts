import { Injectable } from '@nestjs/common';
import type { OnboardingDataPort } from '@marinoscar/platform-api/onboarding';

import { PrismaService } from '../../prisma/prisma.service';

// =============================================================================
// The onboarding slice's data port (issue #481, epic #478)
// =============================================================================
//
// What the platform's built-in facts and the activation metrics read, over this
// app's Prisma client. Every method is ONE bounded read:
//
//   readUserSettingsValue          a `select` of the caller's `user_settings.value`;
//                                  never creates the row (a GET leaves the database
//                                  unchanged for a user with no settings row)
//   countAllowlistEntriesExcept    the `admin.access` fact: allowlist entries other
//                                  than the bootstrap administrator's
//   hasPushSubscription            the `user.notifications` fact
//   queryAggregate                 the metrics' one statement, inside a READ ONLY
//                                  transaction
//
// `orgInviteProgress` is deliberately NOT implemented: this app is single-organization,
// so the platform omits `admin.org-invite` (the step needs the port member).
//
// `transcripts`, `notes` and `users` carry no row-level-security policy (they are
// scoped by `owner_id` in the application), so the metrics' funnel expressions read
// them through the ordinary client; no bypass client is involved.
// =============================================================================

@Injectable()
export class OnboardingDataAdapter implements OnboardingDataPort {
  constructor(private readonly prisma: PrismaService) {}

  async readUserSettingsValue(userId: string): Promise<unknown> {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { value: true },
    });
    return row?.value ?? null;
  }

  async countAllowlistEntriesExcept(exceptEmail: string | null): Promise<number> {
    return this.prisma.allowedEmail.count({
      where:
        exceptEmail === null
          ? {}
          : { NOT: { email: { equals: exceptEmail, mode: 'insensitive' } } },
    });
  }

  async hasPushSubscription(userId: string): Promise<boolean> {
    return (await this.prisma.pushSubscription.count({ where: { userId } })) > 0;
  }

  async queryAggregate<T>(sql: string, values: readonly unknown[]): Promise<T[]> {
    return this.prisma.$transaction(async (tx) => {
      // First statement of the transaction: the aggregate cannot write even if a
      // registered expression were ever wrong.
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return tx.$queryRawUnsafe<T[]>(sql, ...values);
    });
  }
}

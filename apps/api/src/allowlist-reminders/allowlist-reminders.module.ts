import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AllowlistRemindersController } from './allowlist-reminders.controller';
import { AllowlistRemindersService } from './allowlist-reminders.service';

/**
 * Allowlist invitation reminders: the KVox-only feature the platform's
 * allowlist has no seam for (#301, moved to a side table by #465).
 *
 * `AUDIT_SINK` comes from the global `PlatformHostModule`, and the guards'
 * dependencies from the global identity slice, so neither is imported here.
 */
@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [AllowlistRemindersController],
  providers: [AllowlistRemindersService],
})
export class AllowlistRemindersModule {}

import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AllowlistController } from './allowlist.controller';
import { AllowlistService } from './allowlist.service';
import { LegacyAllowlistReminderStore } from './legacy-allowlist-reminder.store';

@Module({
  // `AllowlistService.addEmail` raises `allowlist.invitation` (#128).
  imports: [PrismaModule, NotificationsModule],
  controllers: [AllowlistController],
  // PLATFORM-ADOPTION-SHIM(#465): the reminder columns are not on the Prisma client.
  providers: [AllowlistService, LegacyAllowlistReminderStore],
  exports: [AllowlistService],
})
export class AllowlistModule {}

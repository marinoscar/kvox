import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AllowlistController } from './allowlist.controller';
import { AllowlistService } from './allowlist.service';

@Module({
  // `AllowlistService.addEmail` raises `allowlist.invitation` (#128).
  imports: [PrismaModule, NotificationsModule],
  controllers: [AllowlistController],
  providers: [AllowlistService],
  exports: [AllowlistService],
})
export class AllowlistModule {}

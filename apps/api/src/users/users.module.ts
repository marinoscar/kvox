import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  // `UsersService.updateUserRoles` raises `security.role_changed` (#128).
  // Imported explicitly — NotificationsModule is not @Global — so every
  // feature able to send a notification shows up in a diff.
  imports: [NotificationsModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}

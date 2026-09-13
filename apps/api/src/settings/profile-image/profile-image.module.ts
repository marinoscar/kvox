import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings.module';
import { StorageProvidersModule } from '../../storage/providers/storage-providers.module';
import { ProfileImageController } from './profile-image.controller';
import { ProfileImageService } from './profile-image.service';
import { AvatarController } from './avatar.controller';
import { AvatarService } from './avatar.service';

/**
 * Uploaded profile pictures (#367).
 *
 * Separate from `SettingsModule` because it needs the storage provider, and
 * `SettingsModule` must stay a leaf: `StorageModule` -> `JobsModule` ->
 * `SettingsModule` already exists, so settings importing storage would be a
 * cycle. `StorageProvidersModule` (one token, no controllers), not
 * `StorageModule`, for the reason `JobsModule` documents.
 */
@Module({
  imports: [SettingsModule, StorageProvidersModule],
  controllers: [ProfileImageController, AvatarController],
  providers: [ProfileImageService, AvatarService],
})
export class ProfileImageModule {}

import { Module } from '@nestjs/common';
import { StorageProvidersModule } from '../../storage/providers/storage-providers.module';
import { ProfileImageController } from './profile-image.controller';
import { ProfileImageService } from './profile-image.service';
import { AvatarController } from './avatar.controller';
import { AvatarService } from './avatar.service';

/**
 * Uploaded profile pictures (#367).
 *
 * Separate from the platform `SettingsModule` because it needs the storage
 * provider, and the settings slice must stay a leaf: `StorageModule` ->
 * `JobsModule` -> settings already exists, so settings importing storage would
 * be a cycle. The settings slice is global (#466), so this module imports it
 * for nothing. It moves to the storage slice in #469. `StorageProvidersModule` (one token, no controllers), not
 * `StorageModule`, for the reason `JobsModule` documents.
 */
@Module({
  imports: [StorageProvidersModule],
  controllers: [ProfileImageController, AvatarController],
  providers: [ProfileImageService, AvatarService],
})
export class ProfileImageModule {}

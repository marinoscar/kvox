// =============================================================================
// The settings slice's host ports (issue #466, epic #462)
// =============================================================================
//
//   SETTINGS_DATA            -> PrismaService.runInOrg (set_config(..., true))
//   SETTINGS_PROFILE_IMAGES  -> the storage slice's profile-image helpers (#469)
//
// `@Global()` so the slice's services resolve both ports from whichever module
// instantiates them.
// =============================================================================

import { Global, Module } from '@nestjs/common';
import { SETTINGS_DATA, SETTINGS_PROFILE_IMAGES } from '@marinoscar/platform-api/settings';

import { SettingsDataAdapter } from './settings-data.adapter';
import { SettingsProfileImagesAdapter } from './settings-profile-images.adapter';

@Global()
@Module({
  providers: [
    { provide: SETTINGS_DATA, useClass: SettingsDataAdapter },
    { provide: SETTINGS_PROFILE_IMAGES, useClass: SettingsProfileImagesAdapter },
  ],
  exports: [SETTINGS_DATA, SETTINGS_PROFILE_IMAGES],
})
export class SettingsHostModule {}

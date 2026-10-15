import { Module, Injectable, type OnModuleInit } from '@nestjs/common';
import { SettingsResolver } from '@marinoscar/platform-api/settings';

import { bindAboutSettingsResolver } from '../../app-registrations/host';

// PLATFORM-ADOPTION-SHIM(#464): hands the platform `SettingsResolver` to the
// "Transcription" About group, which is registered at module load and cannot
// inject it (see `app-registrations/host.ts`).
@Injectable()
export class AboutContributorsBinder implements OnModuleInit {
  constructor(private readonly resolver: SettingsResolver) {}

  onModuleInit(): void {
    bindAboutSettingsResolver(this.resolver);
  }
}

@Module({ providers: [AboutContributorsBinder] })
export class AboutContributorsModule {}

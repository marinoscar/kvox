// =============================================================================
// A stand-in for the platform's global settings slice (issue #466, epic #462)
// =============================================================================
//
// `app.module.ts` mounts `SettingsModule.forRoot()` as a GLOBAL module, so
// `SystemSettingsService` is injected everywhere without an import. A unit spec
// that compiles a real module graph (`JobsModule`) for lifecycle or
// self-registration and never reads a policy needs the token to RESOLVE, not the
// slice's data ports, controllers and guards behind it. Import this module next
// to the graph under test and pass the methods the spec does call as `useValue`
// by overriding `SystemSettingsService` on the testing builder.
// =============================================================================

import { Global, Module } from '@nestjs/common';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

@Global()
@Module({
  providers: [{ provide: SystemSettingsService, useValue: {} }],
  exports: [SystemSettingsService],
})
export class SettingsStandInModule {}

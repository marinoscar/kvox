// =============================================================================
// RegistryFreezeService (issue #459, mirrors EnterpriseAppBase)
// =============================================================================
//
// Static registries (`defineRegistry`) fill at import time, from the app
// manifest, so every entry is present before Nest instantiates a provider. Once
// the application has bootstrapped, a late `register()` can only be a mistake:
// some consumer may already have read the list. Freezing turns that mistake
// into a loud `FROZEN` error.
//
// `onApplicationBootstrap` (after every module's init hook), not `main.ts`:
// integration specs build the app through `Test.createTestingModule` and would
// never run `main.ts`. Freezing is idempotent, so a second Nest application in
// one Jest worker simply finds the registries already frozen.
// =============================================================================

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';

import { freezeAllRegistries, listDefinedRegistries } from './define-registry';

@Injectable()
export class RegistryFreezeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RegistryFreezeService.name);

  /** Freezes every registry created with `defineRegistry` and logs their sizes. */
  onApplicationBootstrap(): void {
    freezeAllRegistries();

    const registries = listDefinedRegistries();
    const summary = registries.map((r) => `${r.name}(${r.size})`).join(', ');
    this.logger.debug(`Froze ${registries.length} static registries: ${summary || '(none)'}`);
  }
}

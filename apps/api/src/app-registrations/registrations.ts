// =============================================================================
// The app's platform registrations (issue #465, epic #462)
// =============================================================================
//
// IMPORT THIS BEFORE ANYTHING THAT READS THE ROLE, PERMISSION OR OWNERSHIP
// REGISTRIES: `main.ts`, `app.module.ts`, the seed and catalog scripts and the
// test setup all import it first. It fills core's static registries with the
// platform's roles and permissions plus this app's, the user-owned model inventory
// and the model ownership classification. The registries freeze when the
// application bootstraps, so a late registration fails loudly.
//
// Registration is once per process: a second import of this module is a no-op
// (the ES module cache), and registering the same id twice is `DUPLICATE_ID`.
// =============================================================================

import {
  registerPlatformModelOwnership,
  registerPlatformPermissions,
  registerPlatformUserOwnedModels,
} from '@marinoscar/platform-api/manifest';

import { KVOX_MODEL_OWNERSHIP } from './model-ownership';
import { KVOX_PERMISSIONS } from './permissions';
import { KVOX_USER_OWNED_MODELS } from './user-owned-models';

registerPlatformPermissions({ app: { permissions: [KVOX_PERMISSIONS] } });
registerPlatformUserOwnedModels(KVOX_USER_OWNED_MODELS);
registerPlatformModelOwnership(KVOX_MODEL_OWNERSHIP);

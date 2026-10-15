// =============================================================================
// Identity's host ports, bound to this app's CURRENT services (issue #465)
// =============================================================================
//
// The identity slice reaches the app through ports. This module binds them. It
// must be `@Global()`: the slice's `JwtAuthGuard` is instantiated in EVERY
// module whose controllers use `@Auth()`, so the ports it injects have to
// resolve there.
//
//   IDENTITY_NOTIFIER         -> NotificationsService     (moves in #468)
//   IDENTITY_JOBS             -> JobsService + registry   (the platform's, #468)
//   USER_DEFAULTS             -> DEFAULT_USER_SETTINGS    (moves in #466)
//   IDENTITY_PROFILE_IMAGES   -> the storage slice's profile-image helpers (#469)
//   IDENTITY_NODE_CREDENTIALS -> NodeCredentialService    (the platform's, #468)
//
// IDENTITY_METRICS is deliberately UNBOUND: this app has no metrics service, and
// the port is optional (identity then records nothing). IDENTITY_EVENT_BUS and
// IDENTITY_AUTH_CREDENTIALS are unbound for the same reason (the principal
// cache invalidates in this process only; Google reads the environment).
//
// Keep the adapters THIN: #466/#468/#470 should only have to change the
// `useClass` / `useExisting` targets below.
// =============================================================================

import { Global, Module } from '@nestjs/common';
import {
  IDENTITY_JOBS,
  IDENTITY_NODE_CREDENTIALS,
  IDENTITY_NOTIFIER,
  IDENTITY_PROFILE_IMAGES,
  USER_DEFAULTS,
} from '@marinoscar/platform-api/identity';

import { NodeCredentialService } from '@marinoscar/platform-api/nodes';

import { NotificationsModule } from '../../notifications/notifications.module';
import { IdentityJobsAdapter } from './identity-jobs.adapter';
import { IdentityNotifierAdapter } from './identity-notifier.adapter';
import { KvoxProfileImages, KvoxUserDefaults } from './identity-user.adapters';

@Global()
@Module({
  // `NodeCredentialModule` and the jobs slice are themselves @Global, so
  // `NodeCredentialService`, `JobsService` and `JobHandlerRegistry` resolve here
  // without an import.
  imports: [NotificationsModule],
  providers: [
    { provide: IDENTITY_NOTIFIER, useClass: IdentityNotifierAdapter },
    { provide: IDENTITY_JOBS, useClass: IdentityJobsAdapter },
    { provide: USER_DEFAULTS, useClass: KvoxUserDefaults },
    { provide: IDENTITY_PROFILE_IMAGES, useClass: KvoxProfileImages },
    { provide: IDENTITY_NODE_CREDENTIALS, useExisting: NodeCredentialService },
  ],
  exports: [
    IDENTITY_NOTIFIER,
    IDENTITY_JOBS,
    USER_DEFAULTS,
    IDENTITY_PROFILE_IMAGES,
    IDENTITY_NODE_CREDENTIALS,
  ],
})
export class IdentityHostModule {}

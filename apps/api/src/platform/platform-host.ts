// =============================================================================
// The platform host: how packaged controllers authenticate (issue #465)
// =============================================================================
//
// Every packaged slice takes its route decorators from the app instead of
// shipping its own, so a packaged route is never public by accident. KVox's
// answer is the identity slice's `@Auth` and `@Public`.
// =============================================================================

import { definePlatformHost } from '@marinoscar/platform-api/core';
import { Auth, Public } from '@marinoscar/platform-api/identity';

import type { PermissionName } from '../common/constants/roles.constants';

export const platformHost = definePlatformHost({
  access: {
    requirePermissions: (permissions) =>
      Auth({ permissions: [...permissions] as PermissionName[] }) as MethodDecorator &
        ClassDecorator,
    requireAuthenticated: () => Auth() as MethodDecorator & ClassDecorator,
    allowPublic: () => Public() as MethodDecorator & ClassDecorator,
  },
});

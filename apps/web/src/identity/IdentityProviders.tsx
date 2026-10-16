/**
 * This app's binding of the identity slice's two providers (issue #465, epic #462).
 *
 * One component, so `App.tsx` and the tests mount the SAME wiring:
 *
 *   - `AuthProvider` drives the session through this app's one `PlatformHttpClient`
 *     (`client={api}`). `onBeforeLogout` runs while the access token is still
 *     valid, before `POST /api/auth/logout`: it drops THIS device's push
 *     subscription so the signed-out account stops receiving pushes here (#365).
 *     It is best-effort, bounded to a few seconds and never throws.
 *   - `IdentityWebAdaptersProvider` hands the identity pages this app's table,
 *     spinner, product name and identity client (`identityAdapters.ts`). It sits
 *     INSIDE the auth provider and OUTSIDE the routes: the login page renders
 *     outside the signed-in shell.
 *
 * Mount it once, inside the router.
 */

import type { ReactNode } from 'react';
import {
  AuthProvider,
  IdentityWebAdaptersProvider,
} from '@marinoscar/platform-web/identity/headless';
import { api } from '../services/api';
import { removePushSubscription } from '@marinoscar/platform-web/notifications/headless';
import { appIdentityAdapters } from './identityAdapters';

export function IdentityProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider client={api} onBeforeLogout={removePushSubscription}>
      <IdentityWebAdaptersProvider adapters={appIdentityAdapters}>
        {children}
      </IdentityWebAdaptersProvider>
    </AuthProvider>
  );
}

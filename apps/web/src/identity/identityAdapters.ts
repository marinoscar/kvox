/**
 * What the packaged identity pages take from this app (issue #465, epic #462).
 *
 * `@marinoscar/platform-web/identity/ui` renders the login, callback, device
 * activation, Access Tokens and Users & Allowlist pages. They are the
 * platform's; what is this app's is handed in here, once, as a module constant:
 *
 *   - `appName`: the product name the sign-in error copy names ("isn't approved
 *     to use this app yet").
 *   - `Spinner`: this app's `LoadingSpinner`, for the whole-page waits.
 *   - `DataTable`: this app's responsive `DataTable`, so the users, allowlist and
 *     token lists keep the table the rest of the Console uses (desktop grid,
 *     mobile cards, saved layouts, CSV export) instead of the package's plain
 *     MUI fallback. The packaged `IdentityDataTableProps` is declared as
 *     assignable to and from this app's `DataTableProps` (same filter-operator
 *     union), so no wrapper is needed; `tsc` is the proof.
 *   - `api`: the identity calls over this app's one `PlatformHttpClient`
 *     (`appPlatformApi`, `platform/platformHost.tsx`). Passed explicitly rather
 *     than through the `PlatformHostProvider`; the adapters' `api` takes
 *     precedence over a host's, and both are the same client.
 *
 * Inferred, not copied: the reference app's `platform/identityAdapters.ts` is
 * not reachable from this environment, so this file is derived from the
 * documented `IdentityWebAdapters` contract in the package's type declarations.
 */

import { APP_NAME } from '@app/shared';
import { createIdentityApi } from '@marinoscar/platform-web/identity/headless';
import type {
  IdentityDataTableComponent,
  IdentityWebAdapters,
} from '@marinoscar/platform-web/identity/headless';
import { DataTable } from '../components/datatable';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { appPlatformApi } from '../platform/platformHost';

export const appIdentityAdapters: IdentityWebAdapters = {
  appName: APP_NAME,
  Spinner: LoadingSpinner,
  DataTable: DataTable as IdentityDataTableComponent,
  api: createIdentityApi(appPlatformApi),
};

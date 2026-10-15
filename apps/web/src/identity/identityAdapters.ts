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
 *   - `api`: the identity calls over this app's one `PlatformHttpClient`. Passed
 *     explicitly (rather than through a `PlatformHostProvider`) because the host
 *     provider arrives with the settings slice (#466); until then nothing else
 *     needs it. The adapters' `api` takes precedence over a host's, so mounting
 *     the host later changes nothing here.
 *
 * Inferred, not copied: the reference app's `platform/identityAdapters.ts` is
 * not reachable from this environment, so this file is derived from the
 * documented `IdentityWebAdapters` contract in the package's type declarations.
 */

import { APP_NAME } from '@app/shared';
import { createPlatformApiClient } from '@marinoscar/platform-web/core';
import { createIdentityApi } from '@marinoscar/platform-web/identity/headless';
import type {
  IdentityDataTableComponent,
  IdentityWebAdapters,
} from '@marinoscar/platform-web/identity/headless';
import { DataTable } from '../components/datatable';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { api } from '../services/api';

/**
 * The packaged `PlatformApiClient` over this app's HTTP client. Built ONCE, at
 * module scope: packaged hooks key on its identity.
 */
export const platformApi = createPlatformApiClient(api);

export const appIdentityAdapters: IdentityWebAdapters = {
  appName: APP_NAME,
  Spinner: LoadingSpinner,
  DataTable: DataTable as IdentityDataTableComponent,
  api: createIdentityApi(platformApi),
};

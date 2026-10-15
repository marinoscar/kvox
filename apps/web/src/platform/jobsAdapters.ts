/**
 * What the packaged jobs pages take from this app (issue #468, epic #462).
 *
 * `@marinoscar/platform-web/jobs/ui` renders Admin -> Operations -> Jobs and Job
 * Insights. They are the platform's; what is this app's is handed in here, once,
 * as a module constant, the same shape as `identity/identityAdapters.ts`:
 *
 *   - `Spinner`: this app's `LoadingSpinner`, for the pages' waits.
 *   - `DataTable`: this app's responsive `DataTable`, so the job and insight
 *     tables keep the table the rest of the Console uses (desktop grid, mobile
 *     cards, saved layouts, CSV export). The packaged `JobsDataTableProps` is
 *     declared assignable to and from this app's `DataTableProps`, the cast is
 *     the same one the identity binding makes and `tsc` is the proof.
 *   - `api`: the jobs calls over this app's one `PlatformHttpClient`
 *     (`appPlatformApi`, `platform/platformHost.tsx`).
 *
 * Mounted by `App.tsx` through `JobsWebAdaptersProvider`, inside the platform
 * host and around the routed tree.
 */

import { createJobsApi } from '@marinoscar/platform-web/jobs/headless';
import type {
  JobsDataTableComponent,
  JobsWebAdapters,
} from '@marinoscar/platform-web/jobs/headless';
import { DataTable } from '../components/datatable';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { appPlatformApi } from './platformHost';

export const appJobsAdapters: JobsWebAdapters = {
  Spinner: LoadingSpinner,
  DataTable: DataTable as JobsDataTableComponent,
  api: createJobsApi(appPlatformApi),
};

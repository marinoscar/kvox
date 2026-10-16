/**
 * What the packaged Database Backup page takes from this app (issue #471, epic
 * #467).
 *
 * `@marinoscar/platform-web/db-backup/ui` renders Admin -> Operations ->
 * Database Backup (the policy, the run history and the restore dialog). The
 * page is the platform's; what is this app's is handed in here, once, as a
 * module constant, the same shape as `platform/jobsAdapters.ts`:
 *
 *   - `DataTable`: this app's responsive `DataTable`, so the run list keeps the
 *     table the rest of the Console uses (desktop grid, mobile cards, saved
 *     layouts). The packaged `DbBackupDataTableProps` is declared assignable to
 *     and from this app's `DataTableProps`; the cast is the one the jobs and
 *     nodes bindings make and `tsc` is the proof.
 *   - `api`: the db-backup calls over this app's one `PlatformHttpClient`
 *     (`appPlatformApi`, `platform/platformHost.tsx`), built once at module
 *     scope because packaged hooks key on its identity.
 *
 * Mounted by `App.tsx` through `DbBackupWebAdaptersProvider`, inside the
 * platform host and around the routed tree.
 */

import { createDbBackupApi } from '@marinoscar/platform-web/db-backup/headless';
import type {
  DbBackupDataTableComponent,
  DbBackupWebAdapters,
} from '@marinoscar/platform-web/db-backup/headless';
import { DataTable } from '../components/datatable';
import { appPlatformApi } from './platformHost';

export const appDbBackupAdapters: DbBackupWebAdapters = {
  DataTable: DataTable as DbBackupDataTableComponent,
  api: createDbBackupApi(appPlatformApi),
};

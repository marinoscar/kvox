/**
 * What the packaged Worker Nodes page takes from this app (issue #468, epic #462).
 *
 * `@marinoscar/platform-web/nodes/ui` renders Admin -> Operations -> Worker Nodes
 * (the fleet, its vitals and the node credentials). The page is the platform's;
 * what is this app's is handed in here, once, as a module constant, the same
 * shape as `platform/jobsAdapters.ts`:
 *
 *   - `Spinner`: this app's `LoadingSpinner`.
 *   - `DataTable`: this app's responsive `DataTable` for the fleet and the
 *     credential lists (the packaged props are assignable to and from this
 *     app's, as for the jobs and identity tables).
 *   - `api`: the nodes calls over this app's one `PlatformHttpClient`.
 *
 * Mounted by `App.tsx` through `NodesWebAdaptersProvider`, next to the jobs one.
 */

import { createNodesApi } from '@marinoscar/platform-web/nodes/headless';
import type {
  NodesDataTableComponent,
  NodesWebAdapters,
} from '@marinoscar/platform-web/nodes/headless';
import { DataTable } from '../components/datatable';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { appPlatformApi } from './platformHost';

export const appNodesAdapters: NodesWebAdapters = {
  Spinner: LoadingSpinner,
  DataTable: DataTable as NodesDataTableComponent,
  api: createNodesApi(appPlatformApi),
};

/**
 * The client half of the maintenance wire contract (issue #258, epic #254),
 * which is the platform's since issue #464 (epic #462).
 *
 * `readMaintenanceBlock` (does this failed response carry the deliberate
 * maintenance marker, and what does it say) and the block store
 * (`reportMaintenanceBlock`, `getMaintenanceBlock`, `clearMaintenanceBlock`,
 * `subscribeToMaintenanceBlock`) live in `@marinoscar/platform-web/host/headless`.
 * They MUST be the package's, not a copy: the packaged `MaintenanceGate`,
 * `MaintenanceBanner` and `MaintenancePage` read that module's one store, so a
 * block reported into a local copy would never reach the gate.
 *
 * What stays this app's is the one hook that feeds the store:
 * `noticeMaintenance`, called by the API client on every failed response. An
 * ordinary 503 (no marker in `details.reason`) is untouched: `readMaintenanceBlock`
 * returns `null` for it, so a crashed upstream still produces exactly the
 * `ApiError` it always did.
 */

import {
  MAINTENANCE_ADMIN_PATH,
  MAINTENANCE_ERROR_MARKER,
  MAINTENANCE_FALLBACK_MESSAGE,
  MAINTENANCE_RETRY_AFTER_SECONDS,
  clearMaintenanceBlock,
  getMaintenanceBlock,
  isDecidingLayer,
  readMaintenanceBlock,
  reportMaintenanceBlock,
  subscribeToMaintenanceBlock,
} from '@marinoscar/platform-web/host/headless';
import type { MaintenanceBlock } from '@marinoscar/platform-web/host/headless';

export {
  MAINTENANCE_ADMIN_PATH,
  MAINTENANCE_ERROR_MARKER,
  MAINTENANCE_FALLBACK_MESSAGE,
  MAINTENANCE_RETRY_AFTER_SECONDS,
  clearMaintenanceBlock,
  getMaintenanceBlock,
  isDecidingLayer,
  readMaintenanceBlock,
  reportMaintenanceBlock,
  subscribeToMaintenanceBlock,
};
export type { MaintenanceBlock };

/**
 * Notice a maintenance window on a failed response. The error is still thrown
 * by the caller: the block is a side channel for the gate, never a replacement
 * for the rejection a caller is awaiting.
 */
export function noticeMaintenance(
  status: number,
  body: { message?: string; code?: string; details?: unknown },
): void {
  const block = readMaintenanceBlock(status, body);
  if (block) {
    reportMaintenanceBlock(block);
  }
}

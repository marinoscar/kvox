// `@AllowDuringMaintenance()` exempts a route (or a whole controller) from the
// maintenance 503. The decorator, and the guard that reads its metadata, are the
// platform's (`MaintenanceGuard`, the application's only `APP_GUARD`, mounted by
// `platform/host-core.config.ts`); this file keeps the import path this app's
// controllers have always used.
export {
  AllowDuringMaintenance,
  ALLOW_DURING_MAINTENANCE_KEY,
} from '@marinoscar/platform-api/core';

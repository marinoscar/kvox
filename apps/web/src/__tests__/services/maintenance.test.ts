/**
 * This app's glue around the platform's maintenance contract — issue #464,
 * epic #462.
 *
 * The recogniser (`readMaintenanceBlock`), the block store and the gate, banner
 * and page that read it are the platform's, proved by `@marinoscar/platform-web`'s
 * own suite. What is this app's, and is asserted here:
 *
 *   - `services/maintenance.ts` re-exports the PACKAGE'S store, not a copy: the
 *     packaged `MaintenanceGate` reads that one module-level store, so a block
 *     reported into a local copy would never reach it;
 *   - `MAINTENANCE_ADMIN_PATH`, the one route the gate never covers, is exactly
 *     the route the Maintenance card declares;
 *   - `noticeMaintenance`, the hook the API client runs on every failed
 *     response, reports a deliberate window and ignores an ordinary 503. (The
 *     same behaviour through the public `api` surface, on both error paths, is
 *     `api.maintenance.test.ts`.)
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as headless from '@marinoscar/platform-web/host/headless';
import {
  MAINTENANCE_ADMIN_PATH,
  MAINTENANCE_ERROR_MARKER,
  clearMaintenanceBlock,
  getMaintenanceBlock,
  noticeMaintenance,
  reportMaintenanceBlock,
} from '../../services/maintenance';
import { ADMIN_SECTIONS } from '../../config/adminSections';

afterEach(() => {
  clearMaintenanceBlock();
});

describe('services/maintenance', () => {
  it('is the platform’s store, not a copy', () => {
    expect(reportMaintenanceBlock).toBe(headless.reportMaintenanceBlock);
    expect(getMaintenanceBlock).toBe(headless.getMaintenanceBlock);

    reportMaintenanceBlock({ message: 'Back soon.', retryAfterSeconds: 30, allowAdmins: true });

    expect(headless.getMaintenanceBlock()?.message).toBe('Back soon.');
  });

  it('exempts exactly the route the Maintenance card declares', () => {
    // The gate lets `MAINTENANCE_ADMIN_PATH` through, mirroring
    // `@AllowDuringMaintenance()` on the API's controller. If the card's route
    // ever moves and this constant does not, the exemption silently starts
    // covering nothing — and an admin blocked by an `allowAdmins: false` window
    // loses the only page that would undo it.
    const card = ADMIN_SECTIONS.flatMap((section) => section.cards).find(
      (c) => c.title === 'Maintenance',
    );

    expect(card, 'ADMIN_SECTIONS must declare a Maintenance card').toBeDefined();
    expect(card!.path).toBe(MAINTENANCE_ADMIN_PATH);
  });
});

describe('noticeMaintenance', () => {
  it('reports a 503 carrying the maintenance marker', () => {
    noticeMaintenance(503, {
      message: 'Upgrading.',
      details: { reason: MAINTENANCE_ERROR_MARKER, retryAfterSeconds: 45, allowAdmins: false },
    });

    expect(getMaintenanceBlock()).toEqual({
      message: 'Upgrading.',
      retryAfterSeconds: 45,
      allowAdmins: false,
    });
  });

  it('ignores an ordinary 503 — the distinction the whole feature rests on', () => {
    noticeMaintenance(503, { message: 'Service Unavailable' });
    noticeMaintenance(503, { message: 'x', details: { reason: 'SOMETHING_ELSE' } });
    noticeMaintenance(500, { message: 'x', details: { reason: MAINTENANCE_ERROR_MARKER } });

    expect(getMaintenanceBlock()).toBeNull();
  });
});

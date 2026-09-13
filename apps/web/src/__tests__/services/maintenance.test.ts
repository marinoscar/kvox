/**
 * The maintenance wire contract, client side — issue #258, epic #254.
 *
 * Two things are under test here, and the first is the more important:
 *
 *   1. THE MIRROR DOES NOT DRIFT. `MAINTENANCE_ERROR_MARKER` and
 *      `MAINTENANCE_RETRY_AFTER_SECONDS` are copies of constants declared in
 *      `apps/api`, and there is no shared type surface between the two packages
 *      to keep them honest (`packages/shared` is deliberately plain JS
 *      constants — see its header). So this suite reads the API's own
 *      `maintenance.guard.ts` OFF DISK and compares, the same technique
 *      `config/destinations.test.ts` uses to check the registry against the
 *      live `App.tsx`. Renaming the marker on the server is then a failing web
 *      test rather than a maintenance screen that silently never appears again.
 *
 *   2. THE RECOGNISER SAYS NO MORE OFTEN THAN IT SAYS YES. `readMaintenanceBlock`
 *      is the whole distinction between a planned window and a broken
 *      deployment, so the negative cases (a 503 with no marker, a marker on
 *      another status, a body that is not what we expected at all) matter more
 *      than the happy path.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
} from '../../services/maintenance';
import { ADMIN_SECTIONS } from '../../config/adminSections';
import type { MaintenanceStatus } from '../../types';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const GUARD_PATH = 'apps/api/src/common/maintenance/maintenance.guard.ts';

/** A well-formed maintenance 503 body, as the API's exception filter emits it. */
function maintenanceBody(overrides: Record<string, unknown> = {}) {
  return {
    statusCode: 503,
    code: 'SERVICE_UNAVAILABLE',
    message: 'Back at 03:00 UTC.',
    details: {
      reason: MAINTENANCE_ERROR_MARKER,
      retryAfterSeconds: 30,
      allowAdmins: true,
    },
    timestamp: new Date().toISOString(),
    path: '/api/users',
    ...overrides,
  };
}

describe('maintenance wire contract — mirrored from the API', () => {
  const guardSource = readFileSync(resolve(repoRoot, GUARD_PATH), 'utf8');

  it('uses the exact marker string the API guard exports', () => {
    const match = guardSource.match(/MAINTENANCE_ERROR_MARKER\s*=\s*'([^']+)'/);

    expect(match, `Could not find MAINTENANCE_ERROR_MARKER in ${GUARD_PATH}`).not.toBeNull();
    expect(MAINTENANCE_ERROR_MARKER).toBe(match![1]);
  });

  it('uses the exact retry delay the API guard exports', () => {
    const match = guardSource.match(/MAINTENANCE_RETRY_AFTER_SECONDS\s*=\s*(\d+)/);

    expect(match, `Could not find MAINTENANCE_RETRY_AFTER_SECONDS in ${GUARD_PATH}`).not.toBeNull();
    expect(MAINTENANCE_RETRY_AFTER_SECONDS).toBe(Number(match![1]));
  });

  it('exempts exactly the route the Maintenance card declares', () => {
    // `MaintenanceGate` lets `MAINTENANCE_ADMIN_PATH` through, mirroring
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

describe('readMaintenanceBlock — what counts as a maintenance window', () => {
  it('recognises a 503 carrying the marker, and reads the operator’s message', () => {
    const block = readMaintenanceBlock(503, maintenanceBody());

    expect(block).toEqual({
      message: 'Back at 03:00 UTC.',
      retryAfterSeconds: 30,
      allowAdmins: true,
    });
  });

  it('REFUSES an ordinary 503 with no marker — the distinction this whole feature rests on', () => {
    // A crashed API, an exhausted pool, a proxy with no healthy backend. Same
    // status, and a client that treated it as a window would tell users about
    // planned maintenance every time the deployment fell over.
    const block = readMaintenanceBlock(503, {
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service Unavailable',
    });

    expect(block).toBeNull();
  });

  it('refuses a 503 whose details carry some OTHER reason', () => {
    expect(
      readMaintenanceBlock(503, maintenanceBody({ details: { reason: 'DB_UNAVAILABLE' } })),
    ).toBeNull();
  });

  it('refuses the marker on any status other than 503', () => {
    // The status is half the contract. A 500 or a 429 that happened to carry
    // the string is not a window, and taking the marker alone as sufficient
    // would make the recogniser trust a field over the protocol.
    for (const status of [200, 429, 500, 502]) {
      expect(readMaintenanceBlock(status, maintenanceBody()), `status ${status}`).toBeNull();
    }
  });

  it('survives a body that is not an object at all', () => {
    // `response.json().catch(() => ({}))` in `api.ts` can hand us anything an
    // upstream chose to serve — an HTML error page parsed as null, a bare
    // string. This runs on the error path of every failed request, so it must
    // never be the thing that throws.
    for (const body of [null, undefined, 'Service Unavailable', 42, []]) {
      expect(readMaintenanceBlock(503, body)).toBeNull();
    }
    expect(readMaintenanceBlock(503, { details: null })).toBeNull();
    expect(readMaintenanceBlock(503, { details: 'nope' })).toBeNull();
  });

  it('falls back to a message of its own rather than rendering an empty screen', () => {
    const block = readMaintenanceBlock(503, maintenanceBody({ message: '   ' }));

    expect(block?.message).toBe(MAINTENANCE_FALLBACK_MESSAGE);
  });

  it('falls back to the mirrored retry delay when the body omits one', () => {
    const block = readMaintenanceBlock(
      503,
      maintenanceBody({ details: { reason: MAINTENANCE_ERROR_MARKER } }),
    );

    expect(block?.retryAfterSeconds).toBe(MAINTENANCE_RETRY_AFTER_SECONDS);
  });

  it('honours a retry delay of 0 instead of treating it as missing', () => {
    // `0` means "retry immediately", which is a real answer. A truthiness check
    // here would silently replace it with 30.
    const block = readMaintenanceBlock(
      503,
      maintenanceBody({ details: { reason: MAINTENANCE_ERROR_MARKER, retryAfterSeconds: 0 } }),
    );

    expect(block?.retryAfterSeconds).toBe(0);
  });

  it('defaults allowAdmins to false — the more restrictive reading', () => {
    // Guessing `true` would tell a user to sign in as an administrator on a
    // window that locks administrators out too.
    const block = readMaintenanceBlock(
      503,
      maintenanceBody({ details: { reason: MAINTENANCE_ERROR_MARKER } }),
    );

    expect(block?.allowAdmins).toBe(false);
  });
});

describe('the block store', () => {
  beforeEach(() => clearMaintenanceBlock());
  afterEach(() => clearMaintenanceBlock());

  const BLOCK = { message: 'Back soon', retryAfterSeconds: 30, allowAdmins: true };

  it('starts empty', () => {
    expect(getMaintenanceBlock()).toBeNull();
  });

  it('notifies subscribers when a block is reported and when it is cleared', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToMaintenanceBlock(listener);

    reportMaintenanceBlock(BLOCK);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getMaintenanceBlock()).toEqual(BLOCK);

    clearMaintenanceBlock();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getMaintenanceBlock()).toBeNull();

    unsubscribe();
    reportMaintenanceBlock(BLOCK);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not re-notify for an identical repeat report', () => {
    // Every in-flight request of a blocked page reports independently — a
    // settings fetch, the bell, the rail's preferences — so re-emitting per
    // failure would re-render the maintenance screen once per request for
    // nothing.
    const listener = vi.fn();
    subscribeToMaintenanceBlock(listener);

    reportMaintenanceBlock(BLOCK);
    reportMaintenanceBlock({ ...BLOCK });
    reportMaintenanceBlock({ ...BLOCK });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does notify when the reported window actually changed', () => {
    const listener = vi.fn();
    subscribeToMaintenanceBlock(listener);

    reportMaintenanceBlock(BLOCK);
    reportMaintenanceBlock({ ...BLOCK, message: 'Longer than expected — back at 04:00.' });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(getMaintenanceBlock()?.message).toBe('Longer than expected — back at 04:00.');
  });

  it('returns a STABLE reference between changes', () => {
    // `useSyncExternalStore` compares snapshots with `Object.is` on every
    // render; a getter that rebuilt the object would loop forever.
    reportMaintenanceBlock(BLOCK);

    expect(getMaintenanceBlock()).toBe(getMaintenanceBlock());
  });

  it('does not notify when clearing an already-empty store', () => {
    const listener = vi.fn();
    subscribeToMaintenanceBlock(listener);

    clearMaintenanceBlock();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('isDecidingLayer', () => {
  const status = { source: 'env' } as MaintenanceStatus;

  it('names the one layer that decided, and only it', () => {
    expect(isDecidingLayer(status, 'env')).toBe(true);
    expect(isDecidingLayer(status, 'memory')).toBe(false);
    expect(isDecidingLayer(status, 'persisted')).toBe(false);
  });
});

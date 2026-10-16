// =============================================================================
// The restore wire contract's own acceptance criteria (issue #286, epic #254)
// =============================================================================
//
// What this file proves is the PROJECTION: that each typed result from
// `database-restore.service.ts` becomes exactly one documented `mode`, that
// nothing which only exists internally leaks onto the wire, and that the two
// places naming the schema-override field cannot drift apart.
//
// What it deliberately does NOT prove is anything that only a request pipeline
// can answer — that a bad `confirmation` starts nothing, that `guided` arrives
// with a 200, that a 409's `details.activeRunId` survives the exception filter.
// Those live in `test/db-backup/db-backup-restore.integration.spec.ts`, driven
// through the real router and the real filter, for the reason stated there.
// =============================================================================

import { RESTORE_STATUSES as SERVICE_RESTORE_STATUSES } from '../database-restore.service';
import type { RestoreRollbackResult, StartRestoreResult } from '../database-restore.service';
import { RESTORE_SCHEMA_OVERRIDE_FIELD } from '../restore-preflight.service';
import type { RestorePreflightResult } from '../restore-preflight.service';
import {
  RESTORE_CONFIRMATION,
  ROLLBACK_CONFIRMATION,
  rollbackRestoreRequestSchema,
  startRestoreRequestSchema,
  toPreflightView,
  toRollbackResponse,
  toStartRestoreResponse,
} from './db-backup-restore.dto';
import { RESTORE_STATUSES as DTO_RESTORE_STATUSES, toRunDto } from './db-backup-run.dto';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const PRE_RESTORE_ID = '44444444-4444-4444-8444-444444444444';

function base(): Omit<RestorePreflightResult & { outcome: 'ok' }, 'outcome'> {
  return {
    runId: RUN_ID,
    targetDatabase: 'appdb',
    scratchDatabase: 'appdb_restore_20260907T030000Z',
    oldDatabase: 'appdb_old_20260907T030000Z',
    gates: [
      {
        id: 'createdb_privilege',
        kind: 'capability',
        verdict: 'pass',
        title: 'CREATEDB privilege',
        detail: 'The connecting role may create databases.',
        action: null,
      },
    ],
    rollback: {
      configured: 'retain_database',
      effective: 'retain_database',
      downgraded: false,
      reason: null,
    },
    archiveMigration: '20260906090000_earlier',
    liveMigration: '20260907120000_later',
    databaseSizeBytes: '9007199254740993',
    freeDiskBytes: null,
  };
}

describe('the restore request contract', () => {
  // =========================================================================
  // ⚠ The confirmation literals
  // =========================================================================

  describe('the confirmation literal', () => {
    it.each([
      [{ confirm: true }],
      [{}],
      [{ confirmation: 'restore' }],
      [{ confirmation: 'RESTOR' }],
      [{ confirmation: '' }],
      [{ confirmation: true }],
      [{ confirmation: ROLLBACK_CONFIRMATION }],
    ])('rejects %j on the restore route', (body) => {
      // Each of these is a body a retry, a replay, a copied cURL line or a
      // fat-fingered edit produces. A boolean `confirm: true` — the shape this
      // design rejected outright — is first on the list on purpose.
      expect(startRestoreRequestSchema.safeParse(body).success).toBe(false);
    });

    it('accepts the exact literal and defaults the override to false', () => {
      const parsed = startRestoreRequestSchema.parse({ confirmation: RESTORE_CONFIRMATION });

      // The ordinary body is exactly `{ "confirmation": "RESTORE" }`; nobody
      // should have to send a flag to NOT override something.
      expect(parsed).toEqual({ confirmation: 'RESTORE', overrideSchemaCheck: false });
    });

    it('uses a DIFFERENT word on the rollback route', () => {
      // So that a body copied from one route to the other is refused rather
      // than silently accepted. In `pre_restore_dump` mode a rollback IS a
      // multi-hour restore, so confusing the two is not harmless.
      expect(RESTORE_CONFIRMATION).not.toBe(ROLLBACK_CONFIRMATION);
      expect(
        rollbackRestoreRequestSchema.safeParse({ confirmation: RESTORE_CONFIRMATION }).success
      ).toBe(false);
      expect(
        rollbackRestoreRequestSchema.safeParse({ confirmation: ROLLBACK_CONFIRMATION }).success
      ).toBe(true);
    });
  });

  // =========================================================================
  // The field the pre-flight names must be a field this DTO accepts
  // =========================================================================

  it('accepts the exact override field the pre-flight publishes', () => {
    // The run-time half of the compile-time tie in the DTO. A rename on either
    // side that skipped one of them would produce a `blocked` body telling the
    // client to set a parameter the endpoint rejects — the most frustrating
    // possible failure, where the server has said exactly what to do.
    expect(Object.keys(startRestoreRequestSchema.shape)).toContain(RESTORE_SCHEMA_OVERRIDE_FIELD);

    const parsed = startRestoreRequestSchema.parse({
      confirmation: RESTORE_CONFIRMATION,
      [RESTORE_SCHEMA_OVERRIDE_FIELD]: true,
    });

    expect(parsed.overrideSchemaCheck).toBe(true);
  });

  // =========================================================================
  // The three restore modes
  // =========================================================================

  describe('toStartRestoreResponse', () => {
    it('maps a started restore to mode "running", with the names to poll and drop', () => {
      const result: StartRestoreResult = {
        outcome: 'started',
        runId: RUN_ID,
        scratchDatabase: 'appdb_restore_20260907T030000Z',
        oldDatabase: 'appdb_old_20260907T030000Z',
        preflight: { ...base(), outcome: 'ok' },
      };

      expect(toStartRestoreResponse(result)).toMatchObject({
        mode: 'running',
        runId: RUN_ID,
        scratchDatabase: 'appdb_restore_20260907T030000Z',
        oldDatabase: 'appdb_old_20260907T030000Z',
        preflight: { outcome: 'ok' },
      });
    });

    it('maps a guided refusal to mode "guided", hoisting the whole command block', () => {
      const result: StartRestoreResult = {
        outcome: 'refused',
        preflight: {
          ...base(),
          outcome: 'guided',
          guidance: {
            reason: 'The connecting role lacks CREATEDB.',
            commands: 'createdb -h db.internal -p 5432 -U appuser appdb_restore_x',
            runbook: 'docs/runbooks/database-restore.md',
          },
        },
      };

      const response = toStartRestoreResponse(result);

      expect(response).toMatchObject({ mode: 'guided', runId: RUN_ID });
      // Hoisted next to the `mode` that selects it, and NOT duplicated inside
      // `preflight`: a client narrows once, and a multi-line command block is
      // never sent twice in one body.
      expect(response).toMatchObject({
        guidance: { commands: expect.stringContaining('db.internal') },
      });
      expect((response as { preflight: Record<string, unknown> }).preflight).not.toHaveProperty(
        'guidance'
      );
    });

    it('maps a blocked refusal to mode "blocked", naming the field that unblocks it', () => {
      const result: StartRestoreResult = {
        outcome: 'refused',
        preflight: {
          ...base(),
          outcome: 'blocked',
          block: {
            gateId: 'schema_compatibility',
            message: 'The archive predates the live schema.',
            overridable: true,
            overrideParameter: RESTORE_SCHEMA_OVERRIDE_FIELD,
          },
        },
      };

      const response = toStartRestoreResponse(result);

      expect(response).toMatchObject({
        mode: 'blocked',
        block: { overridable: true, overrideParameter: 'overrideSchemaCheck' },
        // The comparison the operator's decision rests on travels with the
        // request to make it.
        preflight: {
          archiveMigration: '20260906090000_earlier',
          liveMigration: '20260907120000_later',
        },
      });
      expect((response as { preflight: Record<string, unknown> }).preflight).not.toHaveProperty(
        'block'
      );
    });

    it('throws rather than guessing when a refusal carries an "ok" verdict', () => {
      // Unreachable by construction: `refused` exists only because the
      // pre-flight was not `ok`. Quietly answering `blocked` would hide a
      // contradiction between two files in the one subsystem where a wrong
      // answer is destructive.
      expect(() =>
        toStartRestoreResponse({
          outcome: 'refused',
          preflight: { ...base(), outcome: 'ok' },
        } as StartRestoreResult as Extract<StartRestoreResult, { outcome: 'refused' }>)
      ).toThrow(/contradiction/i);
    });
  });

  describe('toPreflightView', () => {
    it('publishes every gate, including the ones that passed', () => {
      // An operator about to replace their production database is entitled to
      // see WHAT WAS CHECKED, not only what failed: a list of failures alone
      // gives no way to tell "checked, fine" from "never ran".
      const view = toPreflightView({ ...base(), outcome: 'ok' });

      expect(view.gates).toEqual([
        {
          id: 'createdb_privilege',
          kind: 'capability',
          verdict: 'pass',
          title: 'CREATEDB privilege',
          detail: 'The connecting role may create databases.',
          action: null,
        },
      ]);
    });

    it('keeps the byte counts as decimal strings, exact above 2^53', () => {
      const view = toPreflightView({ ...base(), outcome: 'ok' });

      // `Number('9007199254740993')` is 9007199254740992 — silently wrong. The
      // string is the only representation that survives a round trip.
      expect(view.databaseSizeBytes).toBe('9007199254740993');
      expect(JSON.parse(JSON.stringify(view)).databaseSizeBytes).toBe('9007199254740993');
    });

    it('copies gates element-wise, so an internal field cannot leak', () => {
      const withExtra = { ...base(), outcome: 'ok' as const };
      (withExtra.gates[0] as unknown as Record<string, unknown>).internalProbeMs = 42;

      expect(toPreflightView(withExtra).gates[0]).not.toHaveProperty('internalProbeMs');
    });
  });

  // =========================================================================
  // The three rollback modes
  // =========================================================================

  describe('toRollbackResponse', () => {
    it('reports "renamed" and says the process is exiting', () => {
      const result: RestoreRollbackResult = {
        outcome: 'renamed',
        runId: RUN_ID,
        promoted: 'appdb_old_20260907T030000Z',
        parked: 'appdb_restore_20260907T040000Z',
      };

      const response = toRollbackResponse(result);

      expect(response).toMatchObject({
        mode: 'renamed',
        promoted: 'appdb_old_20260907T030000Z',
        parked: 'appdb_restore_20260907T040000Z',
      });
      // Without this, an operator reads the very next failed request as the
      // rollback having gone wrong.
      expect(response.detail).toMatch(/exiting/i);
    });

    it('reports "restore_started" and points at the OTHER run to poll', () => {
      const response = toRollbackResponse({
        outcome: 'restore_started',
        runId: RUN_ID,
        preRestoreRunId: PRE_RESTORE_ID,
      });

      expect(response).toMatchObject({
        mode: 'restore_started',
        runId: RUN_ID,
        preRestoreRunId: PRE_RESTORE_ID,
      });
      // Hours, not seconds — and the row carrying the progress is the
      // pre-restore backup's, not the one that was asked about.
      expect(response.detail).toContain(PRE_RESTORE_ID);
      expect(response.detail).toMatch(/schema check overridden/i);
    });

    it('reports "unavailable" using the service\'s own sentence, unedited', () => {
      const reason =
        'The displaced database "appdb_old_x" has been dropped (past ' +
        'databaseBackup.oldDatabaseRetentionHours) and there is no completed pre-restore ' +
        'backup to fall back on.';

      // The service is the only thing that knows whether the retained database
      // expired or never existed; rewriting it here would put a second, vaguer
      // explanation on the wire.
      expect(toRollbackResponse({ outcome: 'unavailable', runId: RUN_ID, reason })).toEqual({
        mode: 'unavailable',
        runId: RUN_ID,
        detail: reason,
      });
    });
  });

  // =========================================================================
  // The polling contract: `GET runs/{id}` has to carry the restore columns
  // =========================================================================

  describe('toRunDto publishes the restore columns', () => {
    /** A row as Prisma hands it back, mid-restore. */
    const row = (overrides: Record<string, unknown> = {}) =>
      ({
        id: RUN_ID,
        status: 'completed',
        trigger: 'manual',
        startedAt: new Date('2026-09-07T02:00:00.000Z'),
        finishedAt: new Date('2026-09-07T02:41:00.000Z'),
        lastHeartbeatAt: null,
        bytesWritten: 9_007_199_254_740_993n,
        sizeBytes: 9_007_199_254_740_993n,
        storageProvider: 's3',
        storageKey: 'k',
        bucket: 'b',
        format: 'custom',
        checksumSha256: 'abc',
        dbVersion: null,
        appVersion: null,
        migrationName: null,
        verifiedAt: null,
        lastError: null,
        createdById: null,
        restoreStatus: 'restoring',
        restoreError: null,
        restoredAt: null,
        restoredById: null,
        restoreScratchDb: 'appdb_restore_20260907T030000Z',
        restoreOldDb: 'appdb_old_20260907T030000Z',
        swappedAt: null,
        preRestoreBackupId: PRE_RESTORE_ID,
        createdAt: new Date('2026-09-07T02:00:00.000Z'),
        updatedAt: new Date('2026-09-07T03:00:00.000Z'),
        ...overrides,
      }) as never;

    it('carries the field the restore endpoint tells its caller to poll', () => {
      // `POST runs/:id/restore` promises "poll GET runs/{id} and watch
      // restoreStatus". That promise is unkeepable if the polling endpoint does
      // not publish the field, which is why #286 is the issue that publishes it.
      expect(toRunDto(row())).toMatchObject({
        restoreStatus: 'restoring',
        restoreScratchDb: 'appdb_restore_20260907T030000Z',
        restoreOldDb: 'appdb_old_20260907T030000Z',
        preRestoreBackupId: PRE_RESTORE_ID,
        swappedAt: null,
      });
    });

    it('is null on the overwhelming majority of runs, which were never restored', () => {
      expect(toRunDto(row({ restoreStatus: null, restoreOldDb: null }))).toMatchObject({
        restoreStatus: null,
        restoreOldDb: null,
      });
    });

    it('narrows an unrecognised stored value to null rather than publishing it', () => {
      // `restore_status` is a plain `text` column — deliberately, which is why
      // `rolled_back` cost no migration — so a value written by a newer build
      // or by hand during an incident is a real possibility. Publishing it
      // verbatim would put a string outside the documented enum into a response
      // a client narrows on.
      expect(toRunDto(row({ restoreStatus: 'teleporting' })).restoreStatus).toBeNull();
    });

    it('converts the restore timestamps to ISO strings', () => {
      const dto = toRunDto(
        row({
          restoreStatus: 'completed',
          restoredAt: new Date('2026-09-07T03:30:00.000Z'),
          swappedAt: new Date('2026-09-07T03:29:00.000Z'),
        })
      );

      expect(dto.restoredAt).toBe('2026-09-07T03:30:00.000Z');
      expect(dto.swappedAt).toBe('2026-09-07T03:29:00.000Z');
    });
  });

  // =========================================================================
  // The two restore-status lists must not drift apart
  // =========================================================================

  it('agrees with the restore service about the restore statuses', () => {
    // `RESTORE_STATUSES` is re-derived in the DTO layer so that a DTO file does
    // not import a service, and `restore_status` is a plain `text` column so
    // there is no generated union for the compiler to check either list
    // against. This assertion is what stops that convenience from becoming two
    // different answers to "what state is this restore in" — the field a
    // caller is told to poll.
    expect([...DTO_RESTORE_STATUSES]).toEqual([...SERVICE_RESTORE_STATUSES]);
  });
});

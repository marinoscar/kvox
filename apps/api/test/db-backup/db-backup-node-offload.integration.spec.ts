// =============================================================================
// `db.backup.run` on a worker node, over the real HTTP stack (#352, epic #345)
// =============================================================================
//
// `src/nodes/nodes.service.spec.ts` proves the three gates as a unit, against
// a registry this suite's own test handler is registered into. This file
// proves the same rules for THE SHIPPED HANDLER, through the real module
// graph, on the endpoint a worker node actually reads — which is a different
// claim, and the one an operator's fleet depends on:
//
//   1. THE SHIPPED HANDLER IS THE ONE BEING GATED. A unit test can gate a
//      handler it wrote itself and prove nothing about `DatabaseBackupRunHandler`
//      being wired with a broker, a schema and an offload gate at all. Here the
//      registry is the application's, populated by `onModuleInit`.
//   2. THE DEFAULT IS OFF, END TO END. `databaseBackup.nodeOffloadEnabled`
//      ships `false`, so a deployment that upgrades into this release does not
//      begin shipping its database off the API server because somebody
//      registered a node last month. That is a property of the seeded
//      defaults, the settings reader and the claim filter together.
//   3. WITH EVERY GATE OPEN THE TYPE IS PUBLISHED WITH ITS CONTRACT, so a node
//      can validate a result before submitting one.
//
// ⚠ `PgJobRoleBroker` IS SUBSTITUTED, and only it. Its `usable()` opens a
// connection to the cluster and asks a privilege question; a suite that needed
// a real PostgreSQL to answer it is a suite CI skips, and a skipped test guards
// nothing. Everything else here — the controller, the guards, the registry, the
// settings service, the shipped handler — is what `AppModule` wires.
// =============================================================================

import request from 'supertest';

import { PgJobRoleBroker } from '../../src/db-backup/pg-job-role.broker';
import { BACKUP_JOB_TYPE } from '../../src/db-backup/db-backup-runner.service';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { ConfigService } from '@nestjs/config';

import { JobHandlerRegistry } from '../../src/jobs/job-handler.registry';
import { JobWorker } from '../../src/jobs/job.worker';
import { NodeOffloadService } from '../../src/jobs/node-offload.service';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockAdminUser } from '../helpers/auth-mock.helper';
import { closeTestApp, createTestApp, TestContext } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

describe('db.backup.run node offload (Integration)', () => {
  let context: TestContext;

  const broker = {
    kind: 'postgres.readonly',
    usable: jest.fn(),
    issue: jest.fn(),
    revoke: jest.fn(),
    preflight: jest.fn(),
  };

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [{ provide: PgJobRoleBroker, useValue: broker }],
    });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();

    broker.usable.mockReset().mockResolvedValue({ ok: true });
  });

  const server = () => context.app.getHttpServer();

  /**
   * The two switches, written into the one settings row the real
   * `SystemSettingsService` reads.
   *
   * Both namespaces at once, because the point of every case below is which
   * COMBINATION is required — a helper that could only set one would make the
   * "either one off is enough" cases untestable.
   */
  function givenSwitches(input: { broker: boolean; offload: boolean }): void {
    (context.prismaMock.systemSettings.findUnique as jest.Mock).mockResolvedValue({
      id: 'settings-row',
      key: 'default',
      value: {
        ...DEFAULT_SYSTEM_SETTINGS,
        nodes: {
          ...DEFAULT_SYSTEM_SETTINGS.nodes,
          jobSecretBrokerEnabled: input.broker,
        },
        databaseBackup: {
          ...DEFAULT_SYSTEM_SETTINGS.databaseBackup,
          nodeOffloadEnabled: input.offload,
        },
      },
      version: 1,
      updatedByUserId: null,
      updatedAt: new Date(),
    });
  }

  async function offeredTypes(): Promise<string[]> {
    const admin = await createMockAdminUser(context);

    const response = await request(server())
      .get('/api/nodes/job-types')
      .set(authHeader(admin.accessToken))
      .expect(200);

    return (response.body.data.types as { type: string }[]).map((entry) => entry.type);
  }

  it('ships OFF: the type is absent with the seeded defaults, whatever nodes are registered', async () => {
    // No `givenSwitches` call at all — this is the row a deployment that has
    // never touched either setting reads. `setupBaseMocks` supplies it.
    const types = await offeredTypes();

    expect(types).not.toContain(BACKUP_JOB_TYPE);
    // …and the fleet is otherwise unaffected: this is an intersection on one
    // type, not a switch on the node plane.
    expect(types).toContain('example.checksum');
  });

  it('is still absent with brokering ON but offload OFF — the two switches are not one switch', async () => {
    givenSwitches({ broker: true, offload: false });

    expect(await offeredTypes()).not.toContain(BACKUP_JOB_TYPE);
  });

  it('is still absent with offload ON but brokering OFF', async () => {
    // The direction that matters most: a deployment may want the backup
    // offloaded and still not have decided that its fleet may hold database
    // credentials. Enabling one must not imply the other.
    givenSwitches({ broker: false, offload: true });

    expect(await offeredTypes()).not.toContain(BACKUP_JOB_TYPE);
  });

  it('is absent when the broker reports it cannot mint here, even with both switches on', async () => {
    // Managed PostgreSQL denying CREATEROLE is the ordinary case, not a fault
    // (see docs/runbooks/node-job-secrets.md). Offering the type anyway would
    // have a node claim, ask, get a 503 and defer — every poll, forever.
    givenSwitches({ broker: true, offload: true });
    broker.usable.mockResolvedValue({
      ok: false,
      reason: 'the application role lacks CREATEROLE',
      remedy: 'ALTER ROLE app CREATEROLE;',
    });

    expect(await offeredTypes()).not.toContain(BACKUP_JOB_TYPE);
  });

  it('is offered — with its result contract — when all three agree', async () => {
    givenSwitches({ broker: true, offload: true });

    const admin = await createMockAdminUser(context);
    const response = await request(server())
      .get('/api/nodes/job-types')
      .set(authHeader(admin.accessToken))
      .expect(200);

    const entry = (
      response.body.data.types as { type: string; resultSchema: Record<string, unknown> | null }[]
    ).find((candidate) => candidate.type === BACKUP_JOB_TYPE);

    expect(entry).toBeDefined();
    // ⚠ THE CONTRACT IS PUBLISHED, NOT JUST THE NAME. A node validates against
    // this before it submits, and `bytes` being a STRING here is the whole
    // reason a multi-terabyte archive's size survives the round trip.
    expect(entry?.resultSchema).toMatchObject({
      type: 'object',
      properties: {
        storageKey: { type: 'string' },
        bytes: { type: 'string' },
        sha256: { type: 'string' },
      },
    });
    expect((entry?.resultSchema as { required: string[] }).required).toEqual(
      expect.arrayContaining(['storageKey', 'bytes', 'sha256', 'startedAt', 'finishedAt'])
    );
  });

  // ===========================================================================
  // ⚠ THE PARTITION: exactly one executor may claim this type, always
  // ===========================================================================
  //
  // THE BUG THIS PINS IS A HOLE, NOT A WRONG ANSWER. `db.backup.run` is
  // structurally node-eligible, so it left `JobHandlerRegistry.serverOnlyTypes()`
  // for every deployment forever — while all three gates that decide whether a
  // node may actually claim it ship OFF. A `JOBS_WORKER_MODE=system` worker
  // derives its list from "what no node can run", so for a moment in this
  // epic's history the honest answer on such a deployment was: the fleet may
  // not take the backups and the server no longer claims them either. NOBODY
  // TOOK THEM, and the recovery was an operator noticing an alert and editing
  // an environment variable.
  //
  // The fix is that both executors read ONE function in opposite directions.
  // These two cases are that property, asserted from both sides at once — they
  // fail loudly if either side is ever changed alone.

  /**
   * `system` mode's list, from a REAL `JobWorker` over the REAL registry and
   * the REAL `NodeOffloadService` this application wired.
   *
   * ⚠ CONSTRUCTED RATHER THAN RESOLVED, and not by preference:
   * `createTestApp` replaces the container's `JobWorker` with `{}` on purpose
   * (a polling pool against a mocked database logs a failure every interval
   * and adds a timer to every spec). What matters for this property is that
   * the two collaborators the list is DERIVED from are the application's own,
   * which they are — the three stubs below are the claim, settle and throttle
   * paths, none of which `systemModeEligibleTypes` touches.
   */
  async function systemModeTypes(): Promise<string[]> {
    const worker = new JobWorker(
      context.app.get(ConfigService, { strict: false }),
      context.app.get(JobHandlerRegistry, { strict: false }),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      context.app.get(NodeOffloadService, { strict: false })
    );

    return worker.systemModeEligibleTypes();
  }

  it('with offload OFF: the SERVER claims it and no node is offered it', async () => {
    givenSwitches({ broker: true, offload: false });

    expect(await offeredTypes()).not.toContain(BACKUP_JOB_TYPE);
    // …and the in-process worker picks it up, which is the half that used to
    // be missing. A deployment that has not enabled offload still takes its
    // backups, with no environment variable to remember.
    expect(await systemModeTypes()).toContain(BACKUP_JOB_TYPE);
  });

  it('with offload ON: the FLEET is offered it and the server stops claiming it', async () => {
    givenSwitches({ broker: true, offload: true });

    expect(await offeredTypes()).toContain(BACKUP_JOB_TYPE);
    // Exactly the reverse, in the same process, with no restart: the two
    // executors partition the work rather than both racing for it (which
    // `SKIP LOCKED` would survive) or neither taking it (which nothing
    // survives).
    expect(await systemModeTypes()).not.toContain(BACKUP_JOB_TYPE);
  });

  it('leaves NO type unclaimable, whatever the gates say', async () => {
    // The general form, over every registered type in the real application
    // rather than over this file's own fixtures: the two lists are disjoint
    // and together cover the registry. A single derivation that drifted would
    // break one half or the other.
    for (const switches of [
      { broker: false, offload: false },
      { broker: true, offload: false },
      { broker: false, offload: true },
      { broker: true, offload: true },
    ]) {
      givenSwitches(switches);

      const offered = await offeredTypes();
      const server = await systemModeTypes();
      const registered = context.app.get(JobHandlerRegistry, { strict: false }).types();

      expect(server.filter((type) => offered.includes(type))).toEqual([]);
      expect([...offered, ...server].sort()).toEqual([...registered].sort());
    }
  });

  it('does not probe the broker when a switch has already said no', async () => {
    givenSwitches({ broker: true, offload: false });

    await offeredTypes();

    // The probe is the only gate that talks to a database. A deployment that
    // has decided not to offload must not pay for it on every claim.
    expect(broker.usable).not.toHaveBeenCalled();
  });
});

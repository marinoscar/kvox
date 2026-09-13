import { statfs } from 'node:fs/promises';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { DatabaseBackupRun } from '@prisma/client';

import type { SystemDatabaseBackupValue } from '../common/schemas/settings.schema';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import {
  buildOldDatabaseName,
  buildScratchDatabaseName,
  countDistinctClientAddresses,
  probeCreateDatabasePrivilege,
  probePgExtensionAvailable,
  readDataDirectory,
  readDatabaseSizeBytes,
  resolveAdminConnection,
  withAdminConnection,
  type AdminConnection,
  type AdminQueryClient,
} from './admin-connection.util';
import { compareMigrationNames, readLatestAppliedMigration } from './migration-state.util';
import {
  checkPgClientVersion,
  readServerVersionNumWithPgClient,
  type PgVersionCheck,
} from './pg-version.util';

// =============================================================================
// Restore pre-flight (issue #284, epic #254)
// =============================================================================
//
// A restore either works or it destroys the production database, and ALMOST
// EVERYTHING THAT CAN GO WRONG IS KNOWABLE BEFORE ANYTHING IS CREATED. This
// file is the knowing.
//
// ⚠ NO PATH THROUGH THIS SERVICE CREATES, DROPS OR RENAMES ANYTHING. Every
// cluster call it makes is a `SELECT` or a `SHOW`; the four mutating helpers in
// `admin-connection.util.ts` are #285's alone, and the colocated spec asserts
// with spies that none of them is reached on any outcome. The rule is not
// hygiene: an operator asks "can I restore this?" precisely when they have not
// decided to, and a question that leaves a half-created database behind is a
// question nobody can afford to ask.
//
// -----------------------------------------------------------------------------
// THREE OUTCOMES, AND ALL THREE ARE NORMAL
// -----------------------------------------------------------------------------
//
//   `ok`       Proceed. Some gates may still carry warnings; #287's dialog
//              renders every verdict, not just the failures.
//
//   `guided`   A CAPABILITY gate failed, so the answer is a ready-to-paste,
//              fully parameterised command block and a runbook link INSTEAD OF
//              AN ERROR. This is a designed-in path, not a fallback. Managed
//              PostgreSQL routinely denies `CREATEDB` to the role an
//              application connects with, and an operator on such a platform
//              must still be able to restore — with a superuser, by hand, from
//              the same archive. A 4xx here would tell them their platform is
//              unsupported when it is not, in the middle of an incident.
//
//   `blocked`  Something would make the restore fail or silently corrupt the
//              deployment. Only the SCHEMA gate is overridable, and overriding
//              it means accepting the restore-then-`migrate deploy` path.
//
// PRECEDENCE, when more than one gate fails: a non-overridable block first,
// then `guided`, then the schema block. `guided` outranking the schema block is
// deliberate — a `blocked` result tells the operator to re-send with the
// override, and if the automated path could not run anyway (no `CREATEDB`)
// that instruction sends them round a loop. The guided instructions carry the
// schema warning as an extra step instead, and the schema gate's own verdict is
// still in `gates` for the dialog to render.
//
// -----------------------------------------------------------------------------
// A SHORT DISK DOWNGRADES; IT NEVER REFUSES
// -----------------------------------------------------------------------------
//
// `databaseBackup.restoreRollbackMode: retain_database` keeps the displaced
// database on disk, which costs a second full copy and buys a rollback
// measured in seconds (one `ALTER DATABASE ... RENAME`). When there is not
// room for it, pre-flight downgrades the EFFECTIVE mode to `pre_restore_dump`
// — the safety backup #285 takes immediately before swapping — and SAYS SO.
//
// An administrator mid-incident must never be left with no path forward. What
// the downgrade costs them is a real thing and it is reported in those terms:
// the recovery guarantee changes from seconds to hours, because rolling back
// now means restoring an archive rather than renaming a database. That is a
// decision they can act on. "Not enough disk, refused" is not.
//
// -----------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT CHECKED HERE
// -----------------------------------------------------------------------------
//
// ⚠ THE ARCHIVE'S BYTES ARE NOT VERIFIED BY PRE-FLIGHT, AND MUST NOT BE. Proving
// an archive is readable means streaming the whole object back out of storage
// through `pg_restore --list` (#281 does exactly that after an upload), and
// that object is the size of the database — gigabytes, minutes to hours. An
// HTTP request cannot wait on it, and a pre-flight that sometimes takes an hour
// is a pre-flight nobody runs. It is the FIRST PHASE of #285's asynchronous
// restore run, where there is a row to record progress on and a heartbeat to
// prove it is alive. Do not move it here.
//
// The single-active-run slot, the `completed`-only rule, the 404 for a run that
// does not exist and the permission check all belong to #286's endpoint, for
// the same reason `getDownloadUrl`'s do: this service takes a row and answers a
// question about it.
// =============================================================================

/** Where the operator-facing instructions live. Referenced, never restated. */
export const RESTORE_RUNBOOK_PATH = 'docs/runbooks/database-restore.md';

/**
 * Wall-clock bound on the cluster probes, in milliseconds.
 *
 * Pre-flight runs inside an HTTP request and every query it issues is a
 * trivial catalog read, so anything approaching this is a network that accepts
 * a TCP connection and then swallows packets — the shape a firewall rule
 * change produces. Without the bound that request hangs until the proxy gives
 * up, and the operator learns nothing.
 *
 * ⚠ IT IS NOT `statement_timeout`, WHICH STAYS 0. See
 * `admin-connection.util.ts`: a timeout that abandons a `CREATE DATABASE`
 * halfway buys only ambiguity. Nothing in this service creates anything, which
 * is exactly why this one is safe to set here and nowhere else.
 */
export const PREFLIGHT_PROBE_TIMEOUT_MS = 15_000;

/**
 * Parallel jobs suggested in the guided `pg_restore` command.
 *
 * A suggestion in a command an operator can edit, not a policy — but it must
 * be a real number rather than a placeholder, because the whole value of the
 * guided path is that it can be pasted. Four is safe on any server that can
 * host this application and well short of `MAX_RESTORE_JOBS`.
 */
export const GUIDED_RESTORE_JOBS = 4;

/**
 * The REQUEST FIELD that clears the schema-compatibility block.
 *
 * ⚠ IT IS THE API'S FIELD NAME, NOT THIS SERVICE'S OPTION NAME, and the
 * difference is the whole point. {@link RestoreBlock.overrideParameter} exists
 * to tell a CLIENT which field to set on its next request, so publishing the
 * internal option name (`overrideSchemaMismatch`) would hand an operator a
 * parameter the endpoint rejects — the most frustrating possible failure, where
 * the server has said exactly what to do and refuses when you do it.
 *
 * Declared here rather than in #286's DTO so that this service, which is what
 * actually emits the block, owns the string; the DTO imports it and ties its
 * own schema to it at compile time (`RestoreOverrideFieldIsReal`) and at run
 * time in its spec, so the two cannot drift into naming different things.
 */
export const RESTORE_SCHEMA_OVERRIDE_FIELD = 'overrideSchemaCheck';

// -----------------------------------------------------------------------------
// The result model
// -----------------------------------------------------------------------------

/** The gates, in the order they are evaluated and reported. */
export const RESTORE_GATE_IDS = [
  'pg_client_version',
  'admin_connection',
  'createdb_privilege',
  'extensions',
  'disk_space',
  'replicas',
  'schema_compatibility',
] as const;

export type RestoreGateId = (typeof RESTORE_GATE_IDS)[number];

/**
 * The gates whose failure means "this deployment cannot do this automatically,
 * and here is how a human can".
 *
 * ⚠ `pg_client_version` IS A CAPABILITY GATE AND IS DELIBERATELY NOT IN THIS
 * LIST. Its only actionable failure is the block (see
 * {@link DatabaseRestorePreflightService.versionGate}), and its other non-pass
 * verdict is `unknown` — an unparseable version banner, which is not evidence
 * that anything is wrong. Routing that to `guided` would send an operator into
 * a manual restore, during an incident, because a string did not parse.
 *
 * A list rather than a predicate over `kind`, so that adding a gate is a
 * decision about whether its failure has a manual answer, taken here, once.
 */
const GUIDED_GATE_IDS: readonly RestoreGateId[] = [
  'admin_connection',
  'createdb_privilege',
  'extensions',
];

/**
 * What kind of problem a gate reports, which is what decides how a failure is
 * handled.
 *
 *  - `capability` — this deployment cannot perform the automated restore. Fails
 *    to `guided`, except the version pair; see that gate.
 *  - `disk` — there is not room for something. Downgrades, never refuses.
 *  - `replicas` — a heuristic about the deployment's shape. Warning only.
 *  - `overridable` — a correctness question a human may answer. Blocks until
 *    they do.
 */
export type RestoreGateKind = 'capability' | 'disk' | 'replicas' | 'overridable';

/** One gate's verdict. `warning` is a pass that says something. */
export type RestoreGateVerdict = 'pass' | 'warning' | 'block';

/**
 * One gate's finding.
 *
 * ⚠ EVERY GATE PRODUCES ONE OF THESE, INCLUDING THE ONES THAT PASSED. #287's
 * dialog renders the whole list — an operator about to replace their
 * production database is entitled to see what was checked, not only what
 * failed — so a gate that returns nothing when it is happy would leave a hole
 * in that dialog and no way to tell "checked, fine" from "never ran".
 */
export interface RestoreGateResult {
  id: RestoreGateId;
  kind: RestoreGateKind;
  verdict: RestoreGateVerdict;
  /** Short label, safe to render as a row heading. */
  title: string;
  /** What was found, in one or two sentences an operator can act on. */
  detail: string;
  /**
   * What to DO about it, or `null` when there is nothing to do.
   *
   * Per-gate rather than one message on the result, because a `guided` outcome
   * routinely has two or three findings with different remedies and flattening
   * them into one string is how an operator fixes the first and is surprised by
   * the second.
   */
  action: string | null;
}

/**
 * The rollback mode a restore will actually use.
 *
 * `retain_database` and `drop_database` are what `databaseBackup
 * .restoreRollbackMode` stores; `pre_restore_dump` is what `drop_database`
 * MEANS once you ask what the way back is — the `pre_restore` archive #285
 * takes immediately before the swap. Naming the effective mode after the thing
 * that actually recovers you (rather than after the thing that is destroyed) is
 * what makes the downgrade message honest: "retain_database → pre_restore_dump"
 * says what you still have, where "retain_database → drop_database" would only
 * say what you lost.
 */
export type EffectiveRollbackMode = 'retain_database' | 'pre_restore_dump';

/** What a restore's rollback story is, after pre-flight has had its say. */
export interface RestoreRollbackPlan {
  configured: SystemDatabaseBackupValue['restoreRollbackMode'];
  effective: EffectiveRollbackMode;
  /** `true` when disk pressure changed the answer. */
  downgraded: boolean;
  /** Why it changed, in the operator's terms. `null` when it did not. */
  reason: string | null;
}

/** The ready-to-paste answer the `guided` outcome exists to deliver. */
export interface GuidedRestoreInstructions {
  /** Which gate(s) sent the operator here, in one sentence. */
  reason: string;
  /**
   * A complete shell block: real database names, real user, real host and
   * port, real run id. Asserted by string in the tests, because a command
   * block with a placeholder in it is not a deliverable — it is homework.
   */
  commands: string;
  /** Repository-relative path to the runbook that explains the block. */
  runbook: string;
}

/** What blocked, and whether the caller can do anything about it. */
export interface RestoreBlock {
  gateId: RestoreGateId;
  message: string;
  /** `true` only for the schema gate. */
  overridable: boolean;
  /**
   * The request field that overrides it, or `null`.
   *
   * Named here rather than in #286's DTO so the API and this service cannot
   * disagree about what unblocks what.
   */
  overrideParameter: string | null;
}

/** Everything every outcome carries. */
export interface RestorePreflightBase {
  /** The backup this was asked about. */
  runId: string;
  /** The application's database — the one a restore would displace. */
  targetDatabase: string;
  /** The database an archive would be replayed into, if a restore started now. */
  scratchDatabase: string;
  /** The name the live database would be renamed to. */
  oldDatabase: string;
  gates: RestoreGateResult[];
  rollback: RestoreRollbackPlan;
  /** The migration recorded on the archive, and the one live right now. */
  archiveMigration: string | null;
  liveMigration: string | null;
  /**
   * The live database's on-disk size, as a DECIMAL STRING.
   *
   * A string because the value is a `bigint` — `pg_database_size` returns
   * `int8` and `JSON.stringify` refuses a `bigint` outright, which is the same
   * hazard `db-backup-run.dto.ts` converts around for `sizeBytes`. `null` when
   * the cluster could not be read.
   */
  databaseSizeBytes: string | null;
  /** Free bytes where the server keeps its data, as a decimal string, or `null`. */
  freeDiskBytes: string | null;
}

export type RestorePreflightResult =
  | (RestorePreflightBase & { outcome: 'ok' })
  | (RestorePreflightBase & { outcome: 'guided'; guidance: GuidedRestoreInstructions })
  | (RestorePreflightBase & { outcome: 'blocked'; block: RestoreBlock });

export interface RestorePreflightOptions {
  /**
   * Accepts a schema mismatch and proceeds.
   *
   * ⚠ IT UNBLOCKS EXACTLY ONE GATE. A capability failure is not a decision an
   * operator is entitled to override — no amount of accepting makes a role
   * without `CREATEDB` able to create a database — and an override that
   * silenced everything would turn the one deliberate escape hatch in this
   * subsystem into a way to skip all of it. There is an explicit negative test.
   */
  overrideSchemaMismatch?: boolean;
  /** Injected so a test can pin the derived names without moving the wall clock. */
  now?: Date;
}

// -----------------------------------------------------------------------------
// The seam
// -----------------------------------------------------------------------------

/**
 * Everything this service does that touches a real cluster or a real disk.
 *
 * ONE OBJECT, INJECTED AS A WHOLE, so a test substitutes a cluster rather than
 * four unrelated functions. The shape follows `DB_BACKUP_ENGINE` in
 * `db-backup-runner.service.ts` for the same reason it exists there: a suite
 * that needs a live PostgreSQL is a suite CI skips.
 */
export interface RestorePreflightSeam {
  /** Where the admin session goes, and what database it is about. */
  resolveConnection(): AdminConnection;
  /** Runs a read-only unit of work against the maintenance database. */
  withAdminConnection<T>(
    config: AdminConnection,
    fn: (client: AdminQueryClient) => Promise<T>
  ): Promise<T>;
  /** The `pg_restore` client major against the server's. */
  checkClientVersion(): Promise<PgVersionCheck>;
  /**
   * Free bytes on the filesystem holding `path`, or `null` when this process
   * cannot see it.
   *
   * `null` IS THE COMMON CASE and not a failure: the database is external to
   * the compose stack (`infra/compose/base.compose.yml` declares no `db`
   * service), so the server's data directory is usually on a host this
   * container has never heard of. The disk gate turns that into a warning; see
   * {@link DatabaseRestorePreflightService} for why it must never block.
   */
  readFreeDiskBytes(path: string): Promise<bigint | null>;
}

/**
 * Injection token for {@link RestorePreflightSeam}.
 *
 * OPTIONAL, AND LEFT UNBOUND in `DbBackupModule` — the same discipline
 * `DB_BACKUP_ENGINE`, `DB_BACKUP_TIMERS`, `JOB_CLOCK` and `JOB_RANDOM` follow.
 * The application always probes the real cluster; only a test that constructs
 * this service directly can substitute one. A stubbed cluster in production
 * would report a clean pre-flight against nothing at all, which is the single
 * most dangerous lie this subsystem could tell.
 */
export const RESTORE_PREFLIGHT_SEAM = 'RESTORE_PREFLIGHT_SEAM';

/** The real seam. Every member is a thin binding to the utility that owns it. */
export const defaultRestorePreflightSeam: RestorePreflightSeam = {
  resolveConnection: () => resolveAdminConnection(),

  withAdminConnection: (config, fn) =>
    withAdminConnection(config, fn, { timeoutMs: PREFLIGHT_PROBE_TIMEOUT_MS }),

  checkClientVersion: () =>
    checkPgClientVersion({
      // The `pg` seam rather than a Prisma query, matching the backup engine:
      // it answers "what major is the server" without going through an ORM
      // that is bound to a database a restore is about to rename.
      readServerVersionNum: () => readServerVersionNumWithPgClient(),
    }),

  readFreeDiskBytes: async (path: string) => {
    try {
      const stats = await statfs(path);

      // `bavail`, not `bfree`: the difference is the reserved blocks only root
      // may use, and a restore does not run as root. Reporting `bfree` would
      // promise space that `CREATE DATABASE` cannot actually have.
      return BigInt(stats.bsize) * BigInt(stats.bavail);
    } catch {
      return null;
    }
  },
};

// -----------------------------------------------------------------------------

/** What one round of cluster probes produced. Every field survives a failure. */
interface ClusterProbeResult {
  reachable: boolean;
  /** Why it was not, when it was not. */
  error: string | null;
  canCreateDatabase: boolean | null;
  /** Extensions installed in the live database that this cluster cannot offer. */
  missingExtensions: string[];
  /** `null` when the extension check itself could not be performed. */
  checkedExtensions: number | null;
  databaseSizeBytes: bigint | null;
  dataDirectory: string | null;
  distinctClientAddresses: number | null;
}

@Injectable()
export class DatabaseRestorePreflightService {
  private readonly logger = new Logger(DatabaseRestorePreflightService.name);

  private readonly seam: RestorePreflightSeam;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    @Optional()
    @Inject(RESTORE_PREFLIGHT_SEAM)
    seam?: RestorePreflightSeam
  ) {
    this.seam = seam ?? defaultRestorePreflightSeam;
  }

  /**
   * Answers "can this backup be restored, and what will it cost?" without
   * changing anything.
   *
   * @param run the backup row. Looked up, permission-checked and
   * `completed`-filtered by #286's endpoint — this service answers a question
   * about a row it is given, exactly as `getDownloadUrl` does about one it
   * fetched.
   */
  async check(
    run: DatabaseBackupRun,
    options: RestorePreflightOptions = {}
  ): Promise<RestorePreflightResult> {
    const now = options.now ?? new Date();
    const policy = await this.settings.getDatabaseBackupPolicy();
    const connection = this.seam.resolveConnection();

    const scratchDatabase = buildScratchDatabaseName(connection.liveDatabase, now);
    const oldDatabase = buildOldDatabaseName(connection.liveDatabase, now);

    // The version pair and the cluster probes are independent, and both are
    // network round trips; running them together keeps the whole pre-flight
    // inside one perceptible pause rather than two.
    const [version, cluster, liveMigration] = await Promise.all([
      this.readVersionCheck(),
      this.probeCluster(connection),
      readLatestAppliedMigration(this.prisma),
    ]);

    const freeDiskBytes =
      cluster.dataDirectory === null
        ? null
        : await this.seam.readFreeDiskBytes(cluster.dataDirectory);

    const comparison = compareMigrationNames(run.migrationName, liveMigration);

    const gates: RestoreGateResult[] = [
      this.versionGate(version),
      this.adminConnectionGate(cluster, connection),
      this.createDatabaseGate(cluster),
      this.extensionsGate(cluster),
      ...this.diskGate(cluster, freeDiskBytes, policy),
      this.replicaGate(cluster, connection),
      this.schemaGate(comparison, run.migrationName, liveMigration, options),
    ];

    const rollback = this.planRollback(policy, cluster, freeDiskBytes);

    const base: RestorePreflightBase = {
      runId: run.id,
      targetDatabase: connection.liveDatabase,
      scratchDatabase,
      oldDatabase,
      gates,
      rollback,
      archiveMigration: run.migrationName,
      liveMigration,
      databaseSizeBytes: cluster.databaseSizeBytes?.toString() ?? null,
      freeDiskBytes: freeDiskBytes?.toString() ?? null,
    };

    return this.decide(base, run, connection, comparison);
  }

  // =========================================================================
  // Outcome
  // =========================================================================

  /**
   * Turns the gate verdicts into one of the three outcomes.
   *
   * The precedence — hard block, then guided, then the overridable block — is
   * argued in this file's header. It lives in one place so that adding a gate
   * cannot change it by accident.
   */
  private decide(
    base: RestorePreflightBase,
    run: DatabaseBackupRun,
    connection: AdminConnection,
    comparison: ReturnType<typeof compareMigrationNames>
  ): RestorePreflightResult {
    const blocking = base.gates.filter((gate) => gate.verdict === 'block');

    // 1. A non-overridable block. Today that is only the client/server version
    //    pair, and it comes first because nothing else matters if the binaries
    //    cannot speak to the server: the guided block would hand the operator
    //    commands run by the same `pg_restore` that cannot read it.
    const hard = blocking.find((gate) => gate.kind !== 'overridable');
    if (hard !== undefined) {
      return {
        ...base,
        outcome: 'blocked',
        block: {
          gateId: hard.id,
          message: hard.detail,
          overridable: false,
          overrideParameter: null,
        },
      };
    }

    // 2. A capability failure. `guided` outranks the schema block on purpose —
    //    see the header: telling an operator to re-send with an override when
    //    the automated path cannot run at all is a loop, not an instruction.
    const capabilityFailures = base.gates.filter(
      (gate) => gate.verdict === 'warning' && GUIDED_GATE_IDS.includes(gate.id)
    );

    if (capabilityFailures.length > 0) {
      return {
        ...base,
        outcome: 'guided',
        guidance: {
          reason: capabilityFailures.map((gate) => gate.detail).join(' '),
          commands: buildGuidedRestoreCommands({
            connection,
            run,
            scratchDatabase: base.scratchDatabase,
            oldDatabase: base.oldDatabase,
            schemaMismatch: comparison === 'archive_older' || comparison === 'archive_newer',
          }),
          runbook: RESTORE_RUNBOOK_PATH,
        },
      };
    }

    // 3. The schema gate, which a human may override.
    const overridable = blocking[0];
    if (overridable !== undefined) {
      return {
        ...base,
        outcome: 'blocked',
        block: {
          gateId: overridable.id,
          message: overridable.detail,
          overridable: true,
          overrideParameter: RESTORE_SCHEMA_OVERRIDE_FIELD,
        },
      };
    }

    return { ...base, outcome: 'ok' };
  }

  // =========================================================================
  // Probes
  // =========================================================================

  /** {@link checkPgClientVersion}, degraded to `unknown` rather than thrown. */
  private async readVersionCheck(): Promise<PgVersionCheck> {
    try {
      return await this.seam.checkClientVersion();
    } catch (error) {
      // The utility already fails open on every internal error; this catch
      // covers the seam itself. An unreadable version must never be the reason
      // a restore was refused, for the same reason it must never be the reason
      // a backup did not happen.
      this.logger.warn(
        `The PostgreSQL client/server version pair could not be read: ${describe(error)}`
      );

      return {
        status: 'unknown',
        clientMajor: null,
        serverMajor: null,
        message: 'The PostgreSQL client/server version pair could not be read.',
      };
    }
  }

  /**
   * Every cluster read, in ONE session.
   *
   * One connection rather than one per probe, because each of them is a
   * connection to the server whose `max_connections` a restore is about to
   * stress — and because a probe that leaks a session leaks it to the cluster
   * whose live database has to be free of sessions before a rename can succeed.
   *
   * NEVER THROWS. An unreachable cluster is a VERDICT (`guided`), not an
   * exception: the operator's next step is the manual path, which needs the
   * rest of this result to be built.
   */
  private async probeCluster(connection: AdminConnection): Promise<ClusterProbeResult> {
    const empty: ClusterProbeResult = {
      reachable: false,
      error: null,
      canCreateDatabase: null,
      missingExtensions: [],
      checkedExtensions: null,
      databaseSizeBytes: null,
      dataDirectory: null,
      distinctClientAddresses: null,
    };

    // Read through Prisma, deliberately: `pg_extension` is PER-DATABASE, and
    // the admin session is attached to the maintenance database where the
    // application's extensions are not installed. What the archive will try to
    // create is what the LIVE database has.
    const installed = await this.readInstalledExtensions();

    try {
      return await this.seam.withAdminConnection(connection, async (client) => {
        const canCreateDatabase = await probeCreateDatabasePrivilege(client);
        const dataDirectory = await readDataDirectory(client);
        const databaseSizeBytes = await readDatabaseSizeBytes(client, connection.liveDatabase);
        const distinctClientAddresses = await countDistinctClientAddresses(
          client,
          connection.liveDatabase
        );

        const missingExtensions =
          installed === null ? [] : await findMissingExtensions(client, installed);

        return {
          reachable: true,
          error: null,
          canCreateDatabase,
          missingExtensions,
          checkedExtensions: installed?.length ?? null,
          databaseSizeBytes,
          dataDirectory,
          distinctClientAddresses,
        };
      });
    } catch (error) {
      this.logger.warn(
        `The PostgreSQL maintenance connection could not be used for restore pre-flight, so ` +
          `the guided path is the answer: ${describe(error)}`
      );

      return { ...empty, error: describe(error) };
    }
  }

  /**
   * The extensions installed in the LIVE database.
   *
   * `null` when the read failed, which the gate reports as "could not check"
   * rather than "nothing to check" — the two are very different answers and
   * an empty array would quietly claim the safe one.
   */
  private async readInstalledExtensions(): Promise<string[] | null> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ extname: unknown }>>`
        SELECT extname FROM pg_extension ORDER BY extname
      `;

      return rows
        .map((row) => row.extname)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
    } catch {
      return null;
    }
  }

  // =========================================================================
  // Gates
  // =========================================================================

  /**
   * The client/server major pair.
   *
   * ⚠ THE ONE CAPABILITY GATE THAT BLOCKS RATHER THAN GUIDES. Every other
   * capability failure has a manual answer — a superuser can create the
   * database the API's role may not — but the guided block's `pg_restore` is
   * still a `pg_restore`, and a client older than the server refuses to read
   * the archive whoever runs it. The fix is an image rebuild, documented in
   * `docs/runbooks/postgres-client-version.md`, not a command to paste. It is
   * not overridable for the same reason: overriding it produces a restore that
   * fails on the first byte, having already stopped the application.
   *
   * `unknown` PROCEEDS, exactly as it does for a backup. An unparseable version
   * banner is not evidence that a restore would fail, and it must never be the
   * reason a recovery did not happen.
   */
  private versionGate(version: PgVersionCheck): RestoreGateResult {
    if (version.status === 'blocked') {
      return {
        id: 'pg_client_version',
        kind: 'capability',
        verdict: 'block',
        title: 'PostgreSQL client version',
        detail: version.message,
        action:
          'Rebuild the API image with a newer postgresql client package, then run this ' +
          'pre-flight again. See docs/runbooks/postgres-client-version.md.',
      };
    }

    if (version.status === 'unknown') {
      return {
        id: 'pg_client_version',
        kind: 'capability',
        verdict: 'warning',
        title: 'PostgreSQL client version',
        detail: version.message,
        action:
          'Check the client and server majors by hand before restoring: ' +
          'docs/runbooks/postgres-client-version.md.',
      };
    }

    return {
      id: 'pg_client_version',
      kind: 'capability',
      verdict: 'pass',
      title: 'PostgreSQL client version',
      detail: version.message,
      action: null,
    };
  }

  /**
   * Whether the maintenance database can be reached at all.
   *
   * Its failure is a `warning` verdict and not a `block`, which looks wrong
   * until you read {@link decide}: a `capability` warning IS the `guided`
   * trigger. Nothing about an unreachable maintenance database says the
   * archive is bad or that a human with a `psql` prompt cannot restore it — so
   * the honest answer is the manual path, not a refusal.
   */
  private adminConnectionGate(
    cluster: ClusterProbeResult,
    connection: AdminConnection
  ): RestoreGateResult {
    if (cluster.reachable) {
      return {
        id: 'admin_connection',
        kind: 'capability',
        verdict: 'pass',
        title: 'Cluster admin connection',
        detail:
          `Connected to the "${connection.database}" maintenance database at ` +
          `${connection.host}:${connection.port} as "${connection.user}".`,
        action: null,
      };
    }

    return {
      id: 'admin_connection',
      kind: 'capability',
      verdict: 'warning',
      title: 'Cluster admin connection',
      detail:
        `This deployment could not open a session on the "${connection.database}" maintenance ` +
        `database at ${connection.host}:${connection.port}, which an automated restore needs ` +
        'in order to create and rename databases' +
        (cluster.error === null ? '.' : `: ${cluster.error}`),
      action:
        `Restore by hand from a host that can reach ${connection.host}:${connection.port}, ` +
        `or make the "${connection.database}" database reachable by this role and try again.`,
    };
  }

  /**
   * `CREATEDB`, PROBED.
   *
   * The reason the guided path exists at all. Managed PostgreSQL withholds
   * this attribute from application roles as a matter of course, and #285's
   * restore begins with `CREATE DATABASE`. Assuming it would mean discovering
   * the truth at the moment a restore starts — after the operator has
   * committed to it, during an incident.
   */
  private createDatabaseGate(cluster: ClusterProbeResult): RestoreGateResult {
    if (!cluster.reachable) {
      return {
        id: 'createdb_privilege',
        kind: 'capability',
        // NOT a second `warning`: the admin-connection gate has already sent
        // this to `guided`, and two findings for one cause would read as two
        // separate problems to fix.
        verdict: 'pass',
        title: 'CREATE DATABASE privilege',
        detail: 'Not checked: the maintenance connection could not be opened.',
        action: null,
      };
    }

    if (cluster.canCreateDatabase === true) {
      return {
        id: 'createdb_privilege',
        kind: 'capability',
        verdict: 'pass',
        title: 'CREATE DATABASE privilege',
        detail: 'This deployment\'s database role may create databases.',
        action: null,
      };
    }

    return {
      id: 'createdb_privilege',
      kind: 'capability',
      verdict: 'warning',
      title: 'CREATE DATABASE privilege',
      detail:
        'This deployment\'s database role may not create databases, so it cannot restore into ' +
        'a scratch database and swap it in. This is the normal configuration on managed ' +
        'PostgreSQL and does not mean the archive cannot be restored.',
      action:
        'Restore by hand with a role that holds CREATEDB (or a superuser), using the commands ' +
        'below — or grant CREATEDB to this role and run the pre-flight again.',
    };
  }

  /**
   * Whether every extension the live database has is available to the cluster.
   *
   * TWO CATALOGS, AND BOTH ARE NEEDED. `pg_extension` (read from the live
   * database) is what the archive will try to `CREATE EXTENSION`;
   * `pg_available_extensions` is what the server's filesystem can offer. An
   * archive is dumped and restored inside one cluster in the ordinary case, so
   * this normally passes — it earns its place on the day the restore target is
   * a NEW server, provisioned from a different image, where `pgcrypto` or
   * `postgis` simply is not installed. `pg_restore --exit-on-error` would then
   * stop on the `CREATE EXTENSION` line, having already created a scratch
   * database.
   */
  private extensionsGate(cluster: ClusterProbeResult): RestoreGateResult {
    if (!cluster.reachable || cluster.checkedExtensions === null) {
      return {
        id: 'extensions',
        kind: 'capability',
        verdict: 'pass',
        title: 'Required extensions',
        detail: 'Not checked: the installed extensions or the cluster catalog could not be read.',
        action: null,
      };
    }

    if (cluster.missingExtensions.length === 0) {
      return {
        id: 'extensions',
        kind: 'capability',
        verdict: 'pass',
        title: 'Required extensions',
        detail:
          `All ${cluster.checkedExtensions} extension(s) installed in this database are ` +
          'available on this server.',
        action: null,
      };
    }

    return {
      id: 'extensions',
      kind: 'capability',
      verdict: 'warning',
      title: 'Required extensions',
      detail:
        `This server does not offer ${cluster.missingExtensions.join(', ')}, which the ` +
        'database uses. A restore stops at the CREATE EXTENSION statement, after the scratch ' +
        'database has been created.',
      action:
        `Install the extension package(s) for ${cluster.missingExtensions.join(', ')} on the ` +
        'PostgreSQL server, then run the pre-flight again.',
    };
  }

  /**
   * Free disk against the size of the database.
   *
   * ⚠ RETURNS AN ARRAY, AND SOMETIMES AN EMPTY-BUT-FOR-ONE list, because this
   * is the only gate whose verdict and whose CONSEQUENCE (the rollback
   * downgrade) are computed from the same two numbers. Keeping them in one
   * method is what stops the reported verdict and the applied plan from
   * disagreeing — see {@link planRollback}, which reads the same inputs.
   *
   * NOTHING HERE EVER BLOCKS. A restore needs roughly one copy of the database
   * for the scratch replay, and a second copy if the displaced database is
   * retained. When there is not room, the rollback mode downgrades and says
   * so; when the numbers cannot be read at all — the ordinary case for an
   * external server this container cannot see the disk of — it warns. A false
   * block here would refuse a recovery on the strength of a `statfs` against a
   * path that belongs to another host.
   */
  private diskGate(
    cluster: ClusterProbeResult,
    freeDiskBytes: bigint | null,
    policy: SystemDatabaseBackupValue
  ): RestoreGateResult[] {
    if (cluster.databaseSizeBytes === null || freeDiskBytes === null) {
      return [
        {
          id: 'disk_space',
          kind: 'disk',
          verdict: 'warning',
          title: 'Free disk space',
          detail:
            cluster.dataDirectory === null
              ? 'The server\'s data directory is not visible from this process (the usual case ' +
                'for a managed or remote PostgreSQL), so free disk space could not be checked.'
              : `Free space at "${cluster.dataDirectory}" could not be read from this process.`,
          action:
            'Check by hand that the server has room for a full copy of the database' +
            (policy.restoreRollbackMode === 'retain_database' ? ' twice over.' : '.'),
        },
      ];
    }

    const required = requiredDiskBytes(cluster.databaseSizeBytes, policy.restoreRollbackMode);

    if (freeDiskBytes >= required) {
      return [
        {
          id: 'disk_space',
          kind: 'disk',
          verdict: 'pass',
          title: 'Free disk space',
          detail:
            `${formatBytes(freeDiskBytes)} free, and this restore needs about ` +
            `${formatBytes(required)}.`,
          action: null,
        },
      ];
    }

    return [
      {
        id: 'disk_space',
        kind: 'disk',
        verdict: 'warning',
        title: 'Free disk space',
        detail:
          `${formatBytes(freeDiskBytes)} free, and this restore needs about ` +
          `${formatBytes(required)} (the database is ${formatBytes(cluster.databaseSizeBytes)}).` +
          (policy.restoreRollbackMode === 'retain_database'
            ? ' The displaced database will therefore be dropped instead of kept, and the way ' +
              'back becomes the pre-restore archive rather than a rename.'
            : ''),
        action:
          policy.restoreRollbackMode === 'retain_database'
            ? 'Free disk on the database server if you want the seconds-long rollback that ' +
              'retaining the displaced database gives you.'
            : 'Free disk on the database server before restoring; the scratch database needs ' +
              'a full copy of the data.',
      },
    ];
  }

  /**
   * How many distinct client addresses hold sessions on the live database.
   *
   * ⚠ WARNING ONLY, FOREVER. It is a heuristic for "more than one API replica
   * is connected", and #285's swap assumes exactly one: the maintenance flag is
   * per-process, so a second replica keeps serving traffic, gets terminated
   * mid-request by the swap, and then talks to a database that has been renamed
   * out from under it. That is worth telling an operator. It is NOT worth
   * blocking on, because the count also rises for a bastion host, a `psql`
   * session, a metrics exporter or a migration runner — and refusing a
   * legitimate recovery because somebody left a query window open would be
   * indefensible.
   */
  private replicaGate(
    cluster: ClusterProbeResult,
    connection: AdminConnection
  ): RestoreGateResult {
    const count = cluster.distinctClientAddresses;

    if (!cluster.reachable || count === null) {
      return {
        id: 'replicas',
        kind: 'replicas',
        verdict: 'pass',
        title: 'Connected clients',
        detail: 'Not checked: the cluster could not be read.',
        action: null,
      };
    }

    if (count <= 1) {
      return {
        id: 'replicas',
        kind: 'replicas',
        verdict: 'pass',
        title: 'Connected clients',
        detail: `${count} client address is connected to "${connection.liveDatabase}".`,
        action: null,
      };
    }

    return {
      id: 'replicas',
      kind: 'replicas',
      verdict: 'warning',
      title: 'Connected clients',
      detail:
        `${count} distinct client addresses are connected to "${connection.liveDatabase}". ` +
        'A restore assumes one API instance: the maintenance flag is per-process, so any other ' +
        'instance keeps serving, is terminated mid-request by the swap, and then talks to a ' +
        'renamed database. This count also rises for a psql session or an exporter, so it is a ' +
        'hint, not a verdict.',
      action:
        `Scale the application to a single instance for the restore. See ${RESTORE_RUNBOOK_PATH}.`,
    };
  }

  /**
   * The archive's schema against the live one, IN BOTH DIRECTIONS.
   *
   * The only overridable gate. Blocking by default is the point: a restore
   * across a schema boundary is a decision — it means running
   * `prisma migrate deploy` afterwards, or accepting a database with columns
   * the running code has never seen — and a decision has to be made by a
   * person, once, deliberately. See `migration-state.util.ts` for why
   * `archive_newer` is the more dangerous of the two despite looking harmless.
   */
  private schemaGate(
    comparison: ReturnType<typeof compareMigrationNames>,
    archiveMigration: string | null,
    liveMigration: string | null,
    options: RestorePreflightOptions
  ): RestoreGateResult {
    if (comparison === 'match') {
      return {
        id: 'schema_compatibility',
        kind: 'overridable',
        verdict: 'pass',
        title: 'Schema compatibility',
        detail: `The archive and this database are both at migration "${liveMigration}".`,
        action: null,
      };
    }

    if (comparison === 'unknown') {
      return {
        id: 'schema_compatibility',
        kind: 'overridable',
        // A warning, not a block: #281 records the migration name best-effort,
        // so an archive from a run whose audit read failed has a null here
        // through no fault of its own. Refusing to restore it would make a
        // best-effort field load-bearing after the fact.
        verdict: 'warning',
        title: 'Schema compatibility',
        detail:
          'The archive does not record which migration it was taken at' +
          (liveMigration === null ? ', and this database\'s migration could not be read' : '') +
          ', so schema compatibility could not be checked.',
        action:
          'Confirm by hand that the archive matches the running code, and be ready to run ' +
          'the migrations afterwards.',
      };
    }

    const detail =
      comparison === 'archive_older'
        ? `The archive was taken at migration "${archiveMigration}", but this database is at ` +
          `"${liveMigration}". Restoring it rolls the schema back, and the running code expects ` +
          'columns the restored database will not have.'
        : `The archive was taken at migration "${archiveMigration}", which is ahead of this ` +
          `database's "${liveMigration}". The running code has never seen that schema, and ` +
          'the migration runner will consider it up to date and apply nothing.';

    if (options.overrideSchemaMismatch === true) {
      return {
        id: 'schema_compatibility',
        kind: 'overridable',
        verdict: 'warning',
        title: 'Schema compatibility',
        detail: `${detail} Overridden by the caller.`,
        action:
          'Run the migrations against the restored database as soon as the swap completes ' +
          `(see ${RESTORE_RUNBOOK_PATH}).`,
      };
    }

    return {
      id: 'schema_compatibility',
      kind: 'overridable',
      verdict: 'block',
      title: 'Schema compatibility',
      detail,
      action:
        'Re-send the request with overrideSchemaMismatch to accept the mismatch and take the ' +
        'restore-then-migrate path.',
    };
  }

  // =========================================================================
  // Rollback plan
  // =========================================================================

  /**
   * What the way back will be, after disk has had its say.
   *
   * Reads the SAME two numbers {@link diskGate} does, so the verdict an
   * operator sees and the plan the restore would follow cannot disagree. When
   * the numbers are unreadable the configured mode stands: a downgrade on a
   * guess would silently remove a rollback guarantee the operator asked for.
   */
  private planRollback(
    policy: SystemDatabaseBackupValue,
    cluster: ClusterProbeResult,
    freeDiskBytes: bigint | null
  ): RestoreRollbackPlan {
    const configured = policy.restoreRollbackMode;

    if (configured !== 'retain_database') {
      return {
        configured,
        effective: 'pre_restore_dump',
        downgraded: false,
        reason: null,
      };
    }

    if (cluster.databaseSizeBytes === null || freeDiskBytes === null) {
      return { configured, effective: 'retain_database', downgraded: false, reason: null };
    }

    const required = requiredDiskBytes(cluster.databaseSizeBytes, configured);
    if (freeDiskBytes >= required) {
      return { configured, effective: 'retain_database', downgraded: false, reason: null };
    }

    return {
      configured,
      effective: 'pre_restore_dump',
      downgraded: true,
      reason:
        `Keeping the displaced database needs about ${formatBytes(required)} and only ` +
        `${formatBytes(freeDiskBytes)} is free, so it will be dropped and the pre-restore ` +
        'archive becomes the way back. Rolling this restore back would then mean restoring ' +
        'that archive — hours — rather than renaming a database — seconds.',
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Roughly what a restore needs on the server's data volume.
 *
 * One copy for the scratch database the archive is replayed into, plus one for
 * the displaced database when it is retained. "Roughly" is honest: a restored
 * database is usually a little SMALLER than the original (no bloat, fresh
 * indexes) and WAL, sort files and index builds all want space this does not
 * model. The number exists to catch "there is nowhere near enough", which is
 * the case that matters, and it never blocks — see {@link
 * DatabaseRestorePreflightService.diskGate}.
 */
function requiredDiskBytes(
  databaseSizeBytes: bigint,
  rollbackMode: SystemDatabaseBackupValue['restoreRollbackMode']
): bigint {
  return rollbackMode === 'retain_database' ? databaseSizeBytes * 2n : databaseSizeBytes;
}

/** Which of a database's installed extensions this cluster cannot offer. */
async function findMissingExtensions(
  client: AdminQueryClient,
  installed: string[]
): Promise<string[]> {
  const missing: string[] = [];

  // Serial rather than `Promise.all`: this is one connection, and node-postgres
  // queues concurrent queries on a single client anyway. Writing it as a race
  // would only make the order of the results — which is the order they are
  // reported to a human in — non-deterministic.
  for (const name of installed) {
    if (!(await probePgExtensionAvailable(client, name))) missing.push(name);
  }

  return missing;
}

/** Anything thrown, as a message. JavaScript lets you throw a string. */
function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * A byte count a human can read, from a `bigint`.
 *
 * Hand-rolled rather than reached for from a dependency, and `bigint`
 * throughout until the final division: a database size crossing 2^53 is not
 * reachable today, but the whole reason these columns are `BigInt` is that
 * somebody assumed the same thing about 2^31.
 */
function formatBytes(bytes: bigint): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let index = 0;
  let value = bytes < 0n ? -bytes : bytes;

  while (value >= 1024n && index < units.length - 1) {
    value /= 1024n;
    index += 1;
  }

  return `${value.toString()} ${units[index]}`;
}

/** Everything the guided command block needs to be complete. */
interface GuidedCommandContext {
  connection: AdminConnection;
  run: DatabaseBackupRun;
  scratchDatabase: string;
  oldDatabase: string;
  schemaMismatch: boolean;
}

/**
 * THE GUIDED PATH'S ENTIRE DELIVERABLE: a shell block an operator can paste.
 *
 * ⚠ IT MUST BE COMPLETE AND CORRECTLY PARAMETERISED. Real host, real port,
 * real user, real database names, real run id, real archive filename. A block
 * with `<your-host>` in it is not instructions — it is homework, handed to
 * somebody whose application is down, and every substitution they have to make
 * by hand is a chance to point a `DROP`/`RENAME` at the wrong database. The
 * tests assert this block BY STRING for exactly that reason.
 *
 * TWO VALUES ARE DELIBERATELY NOT INTERPOLATED, and neither is a placeholder in
 * the "fill this in" sense:
 *
 *   - THE PASSWORD. Printing it would put a live database credential into an
 *     HTTP response, a browser's memory, a screenshot and quite possibly a
 *     support ticket. It is exported from the environment the operator already
 *     has.
 *   - THE SIGNED DOWNLOAD URL. It does not exist yet — it is minted, with a
 *     five-minute expiry, by the command on the line above it.
 *
 * Nothing here hard-codes an application, product or repository name: every
 * name in the block is derived from this deployment's own configuration.
 */
export function buildGuidedRestoreCommands(context: GuidedCommandContext): string {
  const { connection, run, scratchDatabase, oldDatabase, schemaMismatch } = context;
  const { host, port, user, liveDatabase, database: maintenanceDatabase } = connection;

  const conn = `--host=${host} --port=${port} --username=${user}`;
  const archiveFile = `/tmp/${basename(run.storageKey)}`;
  const psql = `psql ${conn} --dbname=${maintenanceDatabase}`;

  const lines = [
    `# Manual restore of "${liveDatabase}" from backup run ${run.id}`,
    `# Archive: ${run.storageKey}`,
    '#',
    '# Run these from a host that can reach the database server, as a role that may',
    '# create databases (a superuser, or any role holding CREATEDB). The application',
    '# role could not, which is why you are reading this instead of pressing a button.',
    '#',
    '# The database password is not printed here on purpose - export the one this',
    '# deployment already uses before you start:',
    '#   export PGPASSWORD=...',
    '',
    '# 1. Mint a five-minute download URL for the archive, then fetch it.',
    `appctl api GET /api/admin/db-backup/runs/${run.id}/download`,
    `curl -fSL -o ${archiveFile} "<the url printed by the command above>"`,
    '',
    '# 2. Create the scratch database. This is the step the application role',
    '#    could not perform; nothing is touched in the live database yet.',
    `createdb ${conn} ${scratchDatabase}`,
    '',
    '# 3. Replay the archive into it. --exit-on-error is load-bearing: without it',
    '#    pg_restore logs failures, carries on, and exits 0 - and you would swap a',
    '#    half-populated database into place believing it worked.',
    `pg_restore ${conn} --dbname=${scratchDatabase} \\`,
    `  --no-owner --no-acl --exit-on-error --jobs=${GUIDED_RESTORE_JOBS} \\`,
    `  ${archiveFile}`,
    '',
    '# 4. STOP THE APPLICATION. Everything below renames databases out from under',
    '#    any process still connected, and a rename fails while a session is open.',
    '',
    '# 5. Swap. Both renames are catalog updates: each one either happens or does not.',
    `${psql} \\`,
    `  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${liveDatabase}' AND pid <> pg_backend_pid();" \\`,
    `  -c 'ALTER DATABASE "${liveDatabase}" RENAME TO "${oldDatabase}";' \\`,
    `  -c 'ALTER DATABASE "${scratchDatabase}" RENAME TO "${liveDatabase}";'`,
  ];

  if (schemaMismatch) {
    lines.push(
      '',
      '# 6. The archive and the running code are at different migrations, so bring',
      '#    the restored database up to the schema the code expects before serving.',
      '#    Run this wherever you run migrations for this deployment:',
      '#      npm run prisma:migrate --workspace=api'
    );
  }

  lines.push(
    '',
    `# ${schemaMismatch ? 7 : 6}. Start the application, then verify before you delete anything.`,
    '#    The way back, while the displaced database still exists:',
    `#      ALTER DATABASE "${liveDatabase}" RENAME TO "${scratchDatabase}";`,
    `#      ALTER DATABASE "${oldDatabase}" RENAME TO "${liveDatabase}";`,
    '#',
    `# The whole procedure, with the failure cases, is in ${RESTORE_RUNBOOK_PATH}.`
  );

  return lines.join('\n');
}

/** The last `/`-separated segment of a storage key. */
function basename(storageKey: string): string {
  const parts = storageKey.split('/');

  return parts[parts.length - 1] || storageKey;
}

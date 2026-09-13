// =============================================================================
// The PostgreSQL per-job role broker (issue #350, epic #345)
// =============================================================================
//
// THE FIRST CONCRETE `JobSecretBroker` IN THIS REPOSITORY. #349 shipped the
// contract, the endpoint, the `job_node_secrets` table, both revocation paths
// and the `nodes.jobSecretBrokerEnabled` opt-in with NOTHING registered, so
// that the mechanism could be reviewed on its own and so that no deployment
// could issue anything by accident. This file is what makes it real: it mints
// a SHORT-LIVED, LEAST-PRIVILEGE, SELECT-ONLY PostgreSQL login role for one
// `db.backup.run` job, and drops it again when the job settles.
//
// What it exists to unblock is decision 2 of epic #345: running the database
// dump off the API server. A worker node has no database access and no storage
// credentials (`docs/specs/worker-nodes.md` §8) — every fact it needs arrives
// in an HTTP response — and no amount of presigning produces a database
// connection. This is that connection, and it is deliberately the smallest one
// that can still produce a correct archive.
//
// -----------------------------------------------------------------------------
// ⚠ `pg_dump` DOES NOT NEED `SUPERUSER`. THIS IS THE ASSUMPTION TO CHECK FIRST.
// -----------------------------------------------------------------------------
//
// It is the belief that makes people hand a backup process the application's
// own role, or worse, and it is wrong for the archive this subsystem takes.
// `buildPgDumpArgs` already passes `--no-owner --no-acl` (see `pg-dump.util.ts`
// for why: an archive carrying `ALTER ... OWNER TO` fails on the first restore
// onto a fresh machine, which is precisely the restore that matters). With
// ownership and grants left out of the archive, a dump is a READ: `pg_dump`
// takes an `ACCESS SHARE` lock on every table it copies and reads it, and
// `SELECT` is exactly the privilege that permits both. So a role holding
// `CONNECT` on the database, `USAGE` on the schema and `SELECT` on its tables
// and sequences produces THE SAME BYTES the application role produces.
//
// `pg-job-role.broker.db.spec.ts` proves that against a real PostgreSQL rather
// than asserting it here: it dumps as the minted role and feeds the archive to
// `readTocEntryCount`. If the grants below are ever wrong, that test fails —
// and it is the acceptance test for this whole issue.
//
// -----------------------------------------------------------------------------
// THREE LAYERS UNDER ONE CREDENTIAL, AND THE THIRD IS THE ONE THAT CANNOT FAIL
// -----------------------------------------------------------------------------
//
// #349 gave a grant two ways to be destroyed — the settle-event listener and
// the sweeper — and its header is careful to say the second is not redundant
// with the first. This file adds a third that is not a MECHANISM at all:
//
//   1. `NodeSecretRevoker`, on `JOB_SETTLED_EVENT`: milliseconds after the job
//      settles, in the ordinary case.
//   2. `NodeSecretSweepTask`, on its own cron: the three cases the event path
//      structurally cannot cover (a reaped job, a replica that died between
//      settling and revoking, a `write-failed` terminal outcome).
//   3. ⚠ `VALID UNTIL`, ENFORCED BY POSTGRESQL ITSELF. Both paths above are
//      code in this application, so both can be switched off, deployed
//      broken, or simply never reached — and neither of those possibilities
//      is hypothetical (the sweep has an environment switch; the listener runs
//      in a process that can die). The expiry is not code: it is a column in
//      `pg_authid` that the SERVER checks at authentication time. Total
//      revocation failure therefore does not produce an immortal credential,
//      it produces a role that stops working on a clock nobody in this
//      application can influence, and an orphaned NAME the runbook explains
//      how to sweep by hand (`docs/runbooks/node-job-secrets.md`).
//
// -----------------------------------------------------------------------------
// WHY THE ROLE NAME LOOKS LIKE THAT
// -----------------------------------------------------------------------------
//
// `appjob_<first 8 of the job id>_<6 random hex>`, and both halves earn their
// place:
//
//   * THE FIXED `appjob_` PREFIX IS HOW ORPHANS ARE FOUND. `job_node_secrets`
//     is the ordinary way back to a grant, but layer 3 above exists precisely
//     because that row can be lost — so there must be a way to enumerate
//     grants from the CLUSTER side, with no application state at all. That is
//     one `SELECT rolname FROM pg_roles WHERE rolname LIKE 'appjob\\_%'`, and
//     it is the first command in the runbook. It is also what makes
//     {@link assertBrokerHandle} possible: this broker will only ever `DROP`
//     a name carrying its own prefix, so a corrupted or hostile handle cannot
//     turn revocation into `DROP ROLE postgres`.
//   * THE JOB ID FRAGMENT IS FOR THE HUMAN. An operator looking at a role in
//     `pg_roles` at 3am can find the job it belongs to without a join.
//   * THE RANDOM SUFFIX IS WHAT MAKES RE-ISSUE SAFE. Without it the name is a
//     pure function of the job id, so a re-issue after the row was lost would
//     collide with a role that still exists — `CREATE ROLE` would fail, and
//     the obvious "fix" (dropping first) would silently invalidate a
//     credential another executor is using RIGHT NOW. With it, a name is never
//     reused, and reuse of a GRANT is handled deliberately below instead.
//
// -----------------------------------------------------------------------------
// ONE GRANT PER JOB — AND THE CLUSTER, NOT THE CALLER, IS ASKED WHETHER ONE
// EXISTS
// -----------------------------------------------------------------------------
//
// `JobSecretBroker.issue` is contracted to be idempotent per job: called again
// while a grant is live it must EXTEND that grant and return the SAME handle,
// never mint a sibling. A node asks again as a matter of course — a process
// restarted mid-lease, a response lost on the way back — and a broker that
// minted per call would leak one role per restart into the database it is
// protecting, with the revocation paths (which know exactly one handle) able
// to clean up exactly one of them.
//
// This broker answers that question by LOOKING IN `pg_roles` for its own
// prefix, not by being told. That is deliberate:
//
// REJECTED: passing the existing handle into `issue()`, or injecting Prisma
// here so the broker could read `job_node_secrets` itself. Both make the
// broker's correctness depend on the bookkeeping being intact — and the whole
// reason layer 3 exists is that the bookkeeping is the part that can be lost.
// The cluster is the only authority on which roles exist; asking it costs one
// indexed catalog read on a path that is already opening a connection.
//
// -----------------------------------------------------------------------------
// TWO CONNECTIONS, AND NEITHER IS PRISMA'S
// -----------------------------------------------------------------------------
//
// Everything here goes through `withAdminConnection` — a short-lived
// `pg.Client` opened for one unit of work and closed in a `finally` — for the
// reason `admin-connection.util.ts`'s header states and the restore path
// already insists on: THE POOLED CONNECTIONS ARE NOT THE PLACE FOR CLUSTER
// ADMINISTRATION. Prisma's pool is bound to one database by URL at startup and
// is shared with every request in flight; role management is a cluster-wide,
// non-transactional act, and a `CREATE ROLE` issued on a borrowed pooled
// connection is one an unrelated request's transaction can be sitting inside.
//
// The work needs two sessions because the privileges live in two places:
//
//   * `CREATE ROLE`, `GRANT CONNECT ON DATABASE` and `DROP ROLE` act on
//     CLUSTER-WIDE catalogs, and are issued on the MAINTENANCE database, the
//     same attachment the restore path uses.
//   * `GRANT USAGE ON SCHEMA` / `GRANT SELECT ON ALL TABLES` act on catalogs
//     INSIDE ONE DATABASE, and there is no form of them that can be issued
//     from somewhere else. They are issued on a second session attached to the
//     live database — still outside Prisma's pool, still closed in a `finally`.
//
// -----------------------------------------------------------------------------
// ⚠ `DROP ROLE` ALONE DOES NOT WORK, AND THE FAILURE IS SILENT-ISH
// -----------------------------------------------------------------------------
//
// A role that has been GRANTed privileges on objects cannot simply be dropped:
// PostgreSQL answers `role ... cannot be dropped because some objects depend on
// it`, listing the ACLs. So revocation is `DROP OWNED BY` on the live database
// FIRST (which revokes every privilege granted to the role in the current
// database and, per PostgreSQL's own documentation, on shared objects such as
// the database itself), and only then `DROP ROLE IF EXISTS`. Getting this
// backwards produces a revocation that throws every time, forever, for every
// grant — which the sweeper would faithfully retry until somebody read a log.
//
// The backends the role currently holds are terminated first, best-effort,
// because `DROP ROLE` does NOT disconnect an established session: without it
// "revoked" would mean "cannot reconnect" while a node kept streaming on the
// connection it already had.
//
// -----------------------------------------------------------------------------
// WHAT WAS REJECTED
// -----------------------------------------------------------------------------
//
// REUSE THE APPLICATION'S OWN ROLE. It hands a remote machine full write access
// to production, it cannot be revoked without an outage, and it is a persisted
// credential the instant the node writes it anywhere. This is the design the
// whole epic exists to avoid.
//
// `GRANT pg_read_all_data` (PostgreSQL 14+). Genuinely attractive: one grant,
// covers every schema including ones added later, no `ALL TABLES` snapshot
// problem. Rejected AS THE DEFAULT because it also reads every future table in
// every schema — including the ones a fork adds for tenant isolation — and the
// grant this broker needs is exactly "the tables `pg_dump` is about to read".
// Worth revisiting as an opt-in for multi-schema deployments; it is not a
// silent upgrade.
//
// A LONG-LIVED DEDICATED BACKUP ROLE IN THE ENVIRONMENT. That is a persisted
// credential on hardware the deployment may not own, which decision 3 forbids
// and `job-secret-broker.ts`'s header rejects at length.
//
// -----------------------------------------------------------------------------
// ⚠ NETWORK REACHABILITY IS THE OPERATOR'S PROBLEM, ON PURPOSE
// -----------------------------------------------------------------------------
//
// The material below names the host and port THIS PROCESS connects to. Whether
// a worker node can reach that address is a fact about the deployment's
// network, and for most deployments it means the node sits inside the same
// private network as the database.
//
// There is deliberately NO TUNNELLING here and there must not be one: proxying
// database traffic through this API would put the API in the data path for
// every byte of every dump, which is exactly what the presigned-URL data plane
// (#269) exists to avoid. A deployment whose nodes cannot reach PostgreSQL
// leaves node offload off — the server takes its own backups, which is what it
// did before this epic and what it still does when `usable()` says no.
// `docs/runbooks/node-job-secrets.md` says this in the operator's words.
// =============================================================================

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Job } from '@prisma/client';

import type {
  IssuedJobSecret,
  JobSecretBroker,
  JobSecretUsability,
} from '../jobs/job-secret-broker';
import {
  quoteIdentifier,
  quoteLiteral,
  quoteTimestampLiteral,
  probeCreateRolePrivilege,
  resolveAdminConnection,
  withAdminConnection,
  type AdminConnection,
  type AdminQueryClient,
} from './admin-connection.util';

/**
 * The `kind` this broker mints, recorded on every `job_node_secrets` row.
 *
 * ⚠ PERMANENT once grants exist. It is half of `@@unique([jobId, kind])` and it
 * is how both revocation paths find their way back to the broker that minted a
 * row — renaming it strands every live grant, because the sweeper would then
 * meet rows whose kind matches no registered broker and could only log about
 * them. Dotted, lowercase and product-neutral, exactly like a `Job.type`.
 *
 * `.readonly` is part of the name because it is part of the promise: a future
 * broker that needed a writing role would be a DIFFERENT kind, so that a
 * deployment auditing its grants can tell the two apart from the row alone.
 */
export const PG_JOB_ROLE_KIND = 'postgres.readonly';

/**
 * The prefix every role this broker creates carries.
 *
 * ⚠ LOAD-BEARING IN THREE PLACES: the orphan sweep in the runbook, the
 * "does this job already have a grant?" lookup in {@link PgJobRoleBroker.issue},
 * and {@link assertBrokerHandle}, which is what stops a corrupted handle from
 * turning revocation into `DROP ROLE postgres`. Changing it strands every
 * existing role — they become invisible to all three.
 */
export const JOB_ROLE_PREFIX = 'appjob_';

/**
 * How much of the job id goes into the role name.
 *
 * Eight characters of a UUID, which is for a HUMAN reading `pg_roles` and not
 * for uniqueness — uniqueness is the random suffix's job. Short enough that the
 * whole name is nowhere near {@link MAX_IDENTIFIER_BYTES}, long enough to
 * identify the job at a glance.
 */
export const JOB_ROLE_ID_CHARS = 8;

/** Bytes of randomness in the role-name suffix, rendered as hex. */
const ROLE_SUFFIX_BYTES = 3;

/**
 * How many simultaneous connections one job's role may hold.
 *
 * `pg_dump` uses one connection for `-Fc` without `-j`, so four is generous
 * rather than tight. It is here at all because an UNBOUNDED role is one a
 * compromised or looping node can use to exhaust `max_connections` for the
 * whole deployment — the application included. A bound that never binds in
 * normal operation and caps the worst case is the right shape for this.
 */
export const ROLE_CONNECTION_LIMIT = 4;

/**
 * Password length, in characters of `[A-Za-z0-9]`.
 *
 * 43 characters over a 62-character alphabet is ~256 bits, which is what
 * `randomBytes(32)` provides — the length is derived from the entropy, not
 * chosen for looks. The alphabet is what {@link quoteLiteral} accepts, and
 * that is not a coincidence: see {@link generateRolePassword}.
 */
export const ROLE_PASSWORD_CHARS = 43;

/** The alphabet passwords are generated over. Must satisfy `quoteLiteral`. */
const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * How long a `CREATEROLE` probe is trusted.
 *
 * ⚠ A CACHE, BECAUSE `usable()` IS ON A POLLING PATH. A fleet of nodes asking
 * for work runs `usable()` as part of every claim that could involve this type;
 * without a cache that is one round trip to PostgreSQL per node per poll, to
 * answer a question whose answer changes when an administrator runs a `GRANT`.
 *
 * Sixty seconds is the compromise: short enough that granting `CREATEROLE`
 * takes effect while the operator is still watching, long enough that the probe
 * is amortised across a whole poll cycle. It is deliberately NOT indefinite —
 * a cache that never expires turns "fixed it" into "restart the API".
 */
export const USABLE_CACHE_MS = 60_000;

/** Wall-clock bound on the privilege probe. It runs inside a node's request. */
export const BROKER_PROBE_TIMEOUT_MS = 10_000;

/** Where an operator goes to read about all of this. */
export const NODE_JOB_SECRETS_RUNBOOK_PATH = 'docs/runbooks/node-job-secrets.md';

// -----------------------------------------------------------------------------
// The operator-facing verdict
// -----------------------------------------------------------------------------

/**
 * The paste-ready answer a `guided` outcome exists to deliver.
 *
 * THE SAME SHAPE `GuidedRestoreInstructions` USES, and for the same reason
 * `docs/specs/database-restore.md` argues: a refusal that names no fix is a
 * refusal somebody works around. `commands` is real SQL with the deployment's
 * actual role name in it — a block with a placeholder is not a deliverable, it
 * is homework.
 */
export interface GuidedJobRoleInstructions {
  /** What sent the operator here, in one sentence. */
  reason: string;
  /** A complete SQL block, ready to paste into `psql` as a superuser. */
  commands: string;
  /** Repository-relative path to the runbook that explains the block. */
  runbook: string;
}

/**
 * Whether this deployment can hand a worker node a database credential.
 *
 * ⚠ `guided` IS A 200, NEVER A 4xx OR A 5xx — the precedent
 * `db-backup.controller.ts` states for the restore pair, for the identical
 * reason. Managed PostgreSQL withholding `CREATEROLE` from an application role
 * is the ORDINARY configuration, not a fault: answering it with an error status
 * tells an operator their platform is unsupported when it is not, and what they
 * actually need is two lines of SQL.
 */
export type JobRolePreflightResult =
  | { outcome: 'ok'; kind: string; databaseRole: string; targetDatabase: string; detail: string }
  | {
      outcome: 'guided';
      kind: string;
      databaseRole: string;
      targetDatabase: string;
      detail: string;
      guidance: GuidedJobRoleInstructions;
    };

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

/**
 * A password over exactly the alphabet {@link quoteLiteral} accepts.
 *
 * ⚠ THE ALPHABET IS THE SECURITY BOUNDARY, NOT A STYLE CHOICE. `CREATE ROLE`
 * cannot parameterise its password, so this string is interpolated into SQL.
 * Generating it over `[A-Za-z0-9]` means the value that reaches `quoteLiteral`
 * cannot contain a quote, a backslash, a NUL or anything else an escape
 * function would have to be right about — the injection is unrepresentable
 * rather than escaped. `quoteLiteral` then throws rather than escaping, so the
 * two halves of that argument are enforced at both ends.
 *
 * REJECTED: base64 (`randomBytes(32).toString('base64')`), which is one line
 * shorter and produces `+`, `/` and `=`. Those are legal in a PostgreSQL
 * password and they are exactly the characters that have to survive an escape
 * function here, a percent-encoded connection URL later (`buildDatabaseUrl`'s
 * whole history — see #172), and a JSON round trip to a worker node in
 * between. The entropy is identical; the failure modes are not.
 *
 * REJECTED: modulo over raw bytes (`bytes[i] % 62`), which is one line shorter
 * still and biases the first four letters of the alphabet upward. Rejection
 * sampling costs a few extra bytes of randomness and nothing else.
 */
export function generateRolePassword(length: number = ROLE_PASSWORD_CHARS): string {
  const size = PASSWORD_ALPHABET.length;
  // The largest multiple of the alphabet size that fits in a byte. Bytes at or
  // above it are discarded rather than folded, which is what keeps every
  // character equally likely.
  const ceiling = Math.floor(256 / size) * size;

  let out = '';

  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= ceiling) continue;
      out += PASSWORD_ALPHABET[byte % size];
      if (out.length === length) break;
    }
  }

  return out;
}

/**
 * The identifier-safe fragment of a job id that goes into a role name.
 *
 * Non-alphanumerics are stripped rather than replaced, so a UUID's hyphens
 * disappear and the fragment is hex. Lowercased because PostgreSQL folds
 * unquoted identifiers and a name that differs only in case is a name two
 * humans will read as the same one.
 *
 * `job` when a job id somehow contains nothing usable — the name still has to
 * be a legal identifier, and the random suffix is what makes it unique anyway.
 */
export function jobRoleSlug(jobId: string): string {
  const cleaned = (jobId ?? '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();

  return cleaned.length === 0 ? 'job' : cleaned.slice(0, JOB_ROLE_ID_CHARS);
}

/**
 * `appjob_<job fragment>_<random hex>` — validated before it is returned.
 *
 * Run through {@link quoteIdentifier} here rather than only at the call site so
 * that an unusable name is reported when it is BUILT, before anything has been
 * created. At 22 characters it is nowhere near PostgreSQL's 63-byte limit; the
 * check is a guard against a future change to either half, not a live risk.
 */
export function buildJobRoleName(jobId: string): string {
  const name = `${JOB_ROLE_PREFIX}${jobRoleSlug(jobId)}_${randomBytes(ROLE_SUFFIX_BYTES).toString('hex')}`;

  quoteIdentifier(name);

  return name;
}

/**
 * The `LIKE` pattern matching every role this broker could have minted for one
 * job.
 *
 * ⚠ THE UNDERSCORES ARE ESCAPED, AND FORGETTING THAT IS A REAL BUG RATHER THAN
 * A PEDANTIC ONE: `_` is `LIKE`'s single-character wildcard, so the unescaped
 * pattern `appjob_1234abcd_%` also matches `appjobX1234abcdY…`. It would not
 * match anything in practice today — nothing else in this cluster is named that
 * way — which is precisely why it would survive review and then match something
 * a fork added later.
 */
export function jobRolePattern(jobId: string): string {
  return `${JOB_ROLE_PREFIX.replace(/_/g, '\\_')}${jobRoleSlug(jobId)}\\_%`;
}

/**
 * Refuses any handle this broker could not have minted.
 *
 * ⚠ THE GUARD THAT STOPS `DROP ROLE postgres`. `revoke()` takes a handle read
 * back out of `job_node_secrets` and puts it into DDL. `quoteIdentifier` will
 * happily quote `postgres`, `appuser` or any other perfectly legal identifier —
 * it protects the STATEMENT's syntax, not its meaning. This protects its
 * meaning: the only names this broker will drop are ones carrying its own
 * prefix.
 *
 * It THROWS rather than returning quietly, even though `revoke` is contracted
 * to treat "already gone" as success. A handle outside this broker's namespace
 * is not a grant that has already been cleaned up; it is a row pointing at
 * something else, and the correct outcome is a loud failure that leaves the row
 * for a human — not a silent success that reports having revoked something it
 * never touched.
 */
export function assertBrokerHandle(handle: string): void {
  if (typeof handle !== 'string' || !handle.startsWith(JOB_ROLE_PREFIX)) {
    throw new Error(
      `"${handle}" is not a handle this broker minted: every role it creates begins with ` +
        `"${JOB_ROLE_PREFIX}". Refusing to drop it. Revoke it by hand if it is genuinely a ` +
        `stale job credential, and see ${NODE_JOB_SECRETS_RUNBOOK_PATH}.`
    );
  }
}

/**
 * The two ways to give an application role the privilege to mint job roles.
 *
 * BOTH OPTIONS ARE OFFERED BECAUSE THEY ARE DIFFERENT TRADES, not because one
 * is a fallback. Option A is one statement and hands the application role the
 * ability to create and alter roles generally. Option B keeps that ability in a
 * role of its own that the application role can only use deliberately
 * (`NOINHERIT` means it must `SET ROLE` first), which is the least-privilege
 * answer and the one a security review will ask for.
 *
 * ⚠ ON MANAGED POSTGRESQL, `ALTER ROLE ... CREATEROLE` OFTEN REQUIRES THE
 * PROVIDER'S OWN ADMIN ROLE, and on a few platforms it is not grantable at all.
 * That is a real answer and the runbook says so plainly: leave node offload off
 * and let the API take its own backups. It is not a degraded mode — it is what
 * this deployment did before the epic.
 */
export function buildCreateRoleGrantCommands(databaseRole: string): string {
  return [
    '-- Run as a superuser (or your provider\'s administrative role).',
    '',
    '-- Option A (simplest):',
    `ALTER ROLE ${quoteIdentifier(databaseRole)} CREATEROLE;`,
    '',
    '-- Option B (least privilege - a dedicated minter the app must SET ROLE into):',
    'CREATE ROLE app_job_minter NOINHERIT CREATEROLE;',
    `GRANT app_job_minter TO ${quoteIdentifier(databaseRole)};`,
  ].join('\n');
}

// -----------------------------------------------------------------------------
// The seam
// -----------------------------------------------------------------------------

/**
 * Everything this broker does that touches a real cluster.
 *
 * ONE OBJECT, INJECTED WHOLE, following `RestorePreflightSeam` exactly: a suite
 * that needs a live PostgreSQL is a suite CI skips, and a skipped test guards
 * nothing. The real behaviours that CANNOT be faked — that the grants are
 * sufficient for `pg_dump`, that `DROP ROLE` needs `DROP OWNED BY` first, that
 * `VALID UNTIL` is enforced — are covered by `pg-job-role.broker.db.spec.ts`
 * against a real server.
 */
export interface PgJobRoleSeam {
  /** Where the admin session goes, and which database it is about. */
  resolveConnection(): AdminConnection;
  /** Runs one unit of work against `config.database`, and always closes it. */
  withAdminConnection<T>(
    config: AdminConnection,
    fn: (client: AdminQueryClient) => Promise<T>,
    options?: { timeoutMs?: number }
  ): Promise<T>;
}

/**
 * Injection token for {@link PgJobRoleSeam}.
 *
 * OPTIONAL AND DELIBERATELY LEFT UNBOUND in `DbBackupModule`, exactly as
 * `RESTORE_PREFLIGHT_SEAM`, `DB_BACKUP_ENGINE` and `JOB_CLOCK` are. The
 * application always talks to the real cluster; only a test that constructs
 * this broker directly substitutes one. A stub bound in production is a broker
 * that reports minting credentials it never made.
 */
export const PG_JOB_ROLE_SEAM = 'PG_JOB_ROLE_SEAM';

/** The real seam: two thin bindings to `admin-connection.util.ts`. */
export const defaultPgJobRoleSeam: PgJobRoleSeam = {
  resolveConnection: () => resolveAdminConnection(),
  withAdminConnection: (config, fn, options) => withAdminConnection(config, fn, options),
};

/** What one privilege probe concluded, and for how long it is trusted. */
interface ProbeOutcome {
  ok: boolean;
  reason: string;
  remedy: string;
  /** `true` when the cluster could not be reached at all, which is a different fix. */
  unreachable: boolean;
}

@Injectable()
export class PgJobRoleBroker implements JobSecretBroker {
  private readonly logger = new Logger(PgJobRoleBroker.name);

  readonly kind = PG_JOB_ROLE_KIND;

  private readonly seam: PgJobRoleSeam;

  /** The last probe and when it was taken. See {@link USABLE_CACHE_MS}. */
  private cachedProbe: { at: number; outcome: ProbeOutcome } | null = null;

  constructor(@Optional() @Inject(PG_JOB_ROLE_SEAM) seam?: PgJobRoleSeam) {
    this.seam = seam ?? defaultPgJobRoleSeam;
  }

  // ===========================================================================
  // Usability
  // ===========================================================================

  /**
   * Can this deployment mint a job role right now?
   *
   * ⚠ IT CREATES NOTHING. `JobSecretBroker.usable()` is contracted the same way
   * `docs/specs/database-restore.md` contracts a restore pre-flight — asking
   * "could you?" must never be a step that does — and this honours it with a
   * single catalog read. `pg-job-role.broker.spec.ts` asserts no DDL is issued.
   *
   * Cheap by contract, because it is on the request path of a node waiting to
   * start work: one cached `SELECT` from `pg_roles`, at most one round trip a
   * minute.
   */
  async usable(): Promise<JobSecretUsability> {
    const outcome = await this.probe();

    return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason, remedy: outcome.remedy };
  }

  /**
   * The same question, answered for a HUMAN rather than for a node.
   *
   * `usable()` produces a `reason`/`remedy` pair a node carries in a 503;
   * this produces the `ok` | `guided` verdict an administrator reads, with the
   * command block attached. Both come from ONE probe, so the screen and the
   * node can never disagree about whether this deployment can mint.
   *
   * ⚠ THE PROBE IS TAKEN FRESH HERE, bypassing the cache. An operator opening
   * this page has usually just run the `GRANT` the last verdict told them to,
   * and showing them a minute-old "still no" is how a correct fix reads as a
   * broken one.
   */
  async preflight(): Promise<JobRolePreflightResult> {
    const connection = this.seam.resolveConnection();
    const outcome = await this.probe(true);

    const base = {
      kind: this.kind,
      databaseRole: connection.user,
      targetDatabase: connection.liveDatabase,
    };

    if (outcome.ok) {
      return {
        ...base,
        outcome: 'ok',
        detail:
          `This deployment's database role ("${connection.user}") may create roles, so a worker ` +
          `node can be handed a short-lived, SELECT-only credential for "${connection.liveDatabase}" ` +
          'for the duration of one backup job.',
      };
    }

    return {
      ...base,
      outcome: 'guided',
      detail: outcome.reason,
      guidance: {
        reason: outcome.reason,
        commands: outcome.unreachable
          ? [
              `-- Nothing to paste: the maintenance database at ${connection.host}:${connection.port}`,
              '-- could not be reached at all, so no privilege could be checked. Fix the',
              '-- connection first, then run this pre-flight again.',
            ].join('\n')
          : buildCreateRoleGrantCommands(connection.user),
        runbook: NODE_JOB_SECRETS_RUNBOOK_PATH,
      },
    };
  }

  // ===========================================================================
  // Issuing
  // ===========================================================================

  /**
   * Mint (or extend) the one SELECT-only role for `job`, valid until exactly
   * `until`.
   *
   * ⚠ `until` IS HONOURED EXACTLY — NOT ROUNDED, NOT PADDED, NOT EXTENDED.
   * `JobSecretBroker.issue`'s contract says a broker may grant LESS and must
   * not grant more, and this broker grants precisely what it was asked for:
   * `VALID UNTIL` is `until`, and `expiresAt` echoes it. The clock-skew
   * allowance a database credential genuinely needs — PostgreSQL evaluates
   * `VALID UNTIL` against the DATABASE SERVER's clock while the lease is
   * evaluated against ours — is added by the CALLER
   * (`SECRET_CLOCK_SKEW_ALLOWANCE_MS` in `node-secret-broker.service.ts`), so
   * that "how long should a job credential live" is one decision taken in one
   * place rather than an overhang every broker reinvents. A broker that
   * re-added its own would make the contract false for its own callers, and
   * `pg-job-role.broker.spec.ts` fails if this one ever does.
   *
   * ⚠ THE PASSWORD IS ROTATED ON EVERY CALL, EVEN WHEN THE ROLE IS REUSED, and
   * that is not an oversight. `IssuedJobSecret.material` is handed over once and
   * never stored — there is no column it could go in — so a re-issue cannot
   * return the previous password: nothing in this system still knows it. Setting
   * a fresh one is therefore the only way to answer the second call at all, and
   * it has a useful property: the earlier material stops working the moment a
   * node asks again, so a credential captured from a lost response has a
   * lifetime bounded by the next re-issue as well as by the clock.
   *
   * ⚠ A FAILURE AFTER `CREATE ROLE` DROPS WHAT IT CREATED. The grants run on a
   * second connection, and if they fail the caller gets an exception and never
   * learns the handle — which would leave a login role in the cluster that
   * neither revocation path can find, because both work from handles that were
   * never recorded. This is the same ordering argument
   * `NodeSecretBrokerService` makes when a persist fails, one layer down: the
   * cheap failure must undo the expensive success.
   *
   * ⚠ IT DOES NOT DROP A ROLE IT DID NOT CREATE IN THIS CALL. On the re-issue
   * path the role already has a `job_node_secrets` row, so a failed re-grant
   * leaves a credential that is still recorded and still revocable — destroying
   * it here would invalidate a credential an executor may be using right now.
   */
  async issue(job: Job, until: Date): Promise<IssuedJobSecret> {
    const connection = this.seam.resolveConnection();
    // Exactly `until`. Copied rather than aliased so a caller that mutates the
    // Date it handed us cannot retroactively change what this grant reports.
    const expiresAt = new Date(until.getTime());
    const password = generateRolePassword();

    const { role, created } = await this.seam.withAdminConnection(connection, async (client) => {
      const existing = await this.findExistingRoles(client, job.id);

      if (existing.length > 1) {
        // Only reachable through a bug or a hand-created role that borrowed the
        // prefix. Loud, and then deterministic: the same name is chosen on
        // every subsequent call, so the grant stops multiplying even while the
        // extras remain for an operator to clear.
        this.logger.error(
          `Job ${job.id} has ${existing.length} roles matching this broker's prefix ` +
            `([${existing.join(', ')}]). One job holds ONE credential; reusing "${existing[0]}" ` +
            `and leaving the rest. Drop them by hand — see ${NODE_JOB_SECRETS_RUNBOOK_PATH}.`
        );
      }

      const name = existing[0] ?? buildJobRoleName(job.id);
      const quoted = quoteIdentifier(name);
      // ⚠ INTERPOLATED, NOT BOUND, AND THAT IS FORCED BY THE GRAMMAR: `CREATE
      // ROLE ... PASSWORD $1` is a syntax error, exactly as `CREATE DATABASE $1`
      // is. `quoteLiteral` throws on anything outside the generated alphabet
      // rather than escaping it — see its own header.
      const secret = quoteLiteral(password, 'role password');
      const validUntil = quoteTimestampLiteral(expiresAt);

      // The attribute list is spelled out in full on BOTH paths rather than
      // relying on `CREATE ROLE`'s defaults. The defaults happen to be right
      // today; saying so explicitly means a cluster-level `ALTER ROLE ... SET`
      // or a future default cannot quietly widen what a job credential can do,
      // and it makes the re-issue path re-assert the same attributes rather
      // than trusting whatever the role currently has.
      const attributes =
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION ' +
        `CONNECTION LIMIT ${ROLE_CONNECTION_LIMIT}`;

      if (existing.length === 0) {
        await client.query(
          `CREATE ROLE ${quoted} LOGIN PASSWORD ${secret} VALID UNTIL ${validUntil} ${attributes}`
        );
      } else {
        await client.query(
          `ALTER ROLE ${quoted} WITH LOGIN PASSWORD ${secret} VALID UNTIL ${validUntil} ${attributes}`
        );
      }

      // Cluster-wide catalog, so it belongs on this session rather than the
      // live one; the schema grants below cannot be issued from here at all.
      await client.query(
        `GRANT CONNECT ON DATABASE ${quoteIdentifier(connection.liveDatabase)} TO ${quoted}`
      );

      return { role: name, created: existing.length === 0 };
    });

    try {
      await this.grantReadOnly(connection, role);
    } catch (error) {
      if (created) {
        await this.revokeQuietly(role);
      }

      throw error;
    }

    // ⚠ THE PASSWORD IS NOT IN THIS LINE AND MUST NEVER BE. The role name, the
    // job and the expiry are everything an operator needs to trace a grant; the
    // password is what makes it usable. `NodeSecretBrokerService` holds the same
    // rule one layer up, and `test/nodes/node-job-secret.integration.spec.ts`
    // asserts it across a whole request.
    this.logger.log(
      `${created ? 'Created' : 'Re-issued'} SELECT-only role ${role} on ` +
        `"${connection.liveDatabase}" for job ${job.id}, valid until ${expiresAt.toISOString()}`
    );

    return {
      handle: role,
      expiresAt,
      // ⚠ DISCRETE FIELDS, NEVER A DSN. A `postgresql://user:pass@host/db`
      // string is one accidental log line away from a leaked password, and
      // building one means percent-encoding the password into a URL — the exact
      // round trip #172 exists to stop this repository doing a fourth time.
      // The node assembles its own connection from these; `sslMode` is passed
      // through as libpq's own spelling so it means what `pg_dump` thinks it
      // means.
      material: {
        driver: 'postgresql',
        host: connection.host,
        port: connection.port,
        database: connection.liveDatabase,
        user: role,
        password,
        sslMode: connection.sslMode,
      },
    };
  }

  // ===========================================================================
  // Revocation
  // ===========================================================================

  /**
   * Destroy the role named by `handle`.
   *
   * ⚠ IDEMPOTENT, AND "ALREADY GONE" IS A SUCCESS. Both revocation paths reach
   * this — the settle listener and the sweeper — they can race, and the sweeper
   * routinely meets roles whose `VALID UNTIL` lapsed hours ago and which a
   * previous tick already dropped. A broker that threw on that would turn the
   * fast path's normal outcome into a logged failure and teach everyone to
   * ignore the log.
   *
   * THE ORDER IS FORCED BY POSTGRESQL and is the part worth reading twice:
   *
   *   1. Terminate the role's backends. `DROP ROLE` does not disconnect an
   *      established session, so without this "revoked" means "cannot
   *      reconnect" while a node keeps streaming on the connection it has.
   *      Best-effort: it needs `pg_signal_backend`, which not every deployment
   *      grants, and failing to disconnect a session that is about to lose its
   *      role anyway must not stop the drop.
   *   2. `DROP OWNED BY` on the LIVE database. A role holding granted
   *      privileges cannot be dropped — PostgreSQL answers "cannot be dropped
   *      because some objects depend on it" — and this is the documented way to
   *      clear them. It also covers shared objects, which is what removes the
   *      `GRANT CONNECT` on the database itself.
   *   3. `DROP ROLE IF EXISTS` on the maintenance database.
   *
   * If anything throws, the role is re-checked: gone means somebody else won
   * the race and this call succeeded after all. Still there means a real
   * failure, which is rethrown so the row stays unrevoked and the next sweep
   * retries it.
   */
  async revoke(handle: string): Promise<void> {
    assertBrokerHandle(handle);

    const connection = this.seam.resolveConnection();

    try {
      const present = await this.seam.withAdminConnection(
        { ...connection, database: connection.liveDatabase },
        async (client) => {
          if (!(await this.roleExists(client, handle))) return false;

          await this.terminateRoleBackends(client, handle);
          await client.query(`DROP OWNED BY ${quoteIdentifier(handle)}`);

          return true;
        }
      );

      if (!present) {
        return;
      }

      await this.seam.withAdminConnection(connection, async (client) => {
        await client.query(`DROP ROLE IF EXISTS ${quoteIdentifier(handle)}`);
      });
    } catch (error) {
      if (await this.roleIsGone(connection, handle)) {
        // A concurrent revoke, or an expiry sweep by hand, got there first. The
        // POSTCONDITION this method promises — no such role — holds, so this is
        // a success and not a failure that happens to look like one.
        return;
      }

      throw error;
    }
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  /** Every role in the cluster this broker could have minted for one job. */
  private async findExistingRoles(client: AdminQueryClient, jobId: string): Promise<string[]> {
    const result = await client.query(
      // Bound, not interpolated: this is a VALUE in a `WHERE`, not an
      // identifier in DDL, so the parameter machinery works and is used.
      "SELECT rolname FROM pg_roles WHERE rolname LIKE $1 ESCAPE '\\' ORDER BY rolname",
      [jobRolePattern(jobId)]
    );

    return result.rows
      .map((row) => row.rolname)
      .filter((name): name is string => typeof name === 'string');
  }

  /**
   * The three grants that make a `pg_dump` possible and nothing else possible.
   *
   * ⚠ ON A SESSION ATTACHED TO THE LIVE DATABASE, because there is no other
   * way: schema and table ACLs live in per-database catalogs, and `GRANT ...
   * IN SCHEMA public` has no cross-database form. This is the second of the two
   * connections the file header describes.
   *
   * `ON ALL TABLES` is a SNAPSHOT — it grants on the tables that exist right
   * now, and a table created afterwards is not covered. That is correct here
   * and worth stating so nobody "fixes" it with `ALTER DEFAULT PRIVILEGES`: the
   * grant is minted for one job that is about to start, the dump reads the
   * schema as it stands, and a default-privileges rule would be a PERSISTENT
   * cluster-level change made on behalf of a transient credential.
   *
   * Sequences are included because `pg_dump` reads their last values; without
   * `SELECT` on them the dump fails on the first sequence rather than producing
   * a subtly wrong archive.
   */
  private async grantReadOnly(connection: AdminConnection, role: string): Promise<void> {
    const quoted = quoteIdentifier(role);

    await this.seam.withAdminConnection(
      { ...connection, database: connection.liveDatabase },
      async (client) => {
        await client.query(`GRANT USAGE ON SCHEMA public TO ${quoted}`);
        await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${quoted}`);
        await client.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoted}`);
      }
    );
  }

  /** Whether a role of this exact name exists. */
  private async roleExists(client: AdminQueryClient, role: string): Promise<boolean> {
    const result = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1 LIMIT 1', [role]);

    return result.rows.length > 0;
  }

  /** Whether the role is absent, answered on a fresh session. Never throws. */
  private async roleIsGone(connection: AdminConnection, role: string): Promise<boolean> {
    try {
      return !(await this.seam.withAdminConnection(
        connection,
        (client) => this.roleExists(client, role),
        { timeoutMs: BROKER_PROBE_TIMEOUT_MS }
      ));
    } catch {
      // Could not ask. "Unknown" must not be reported as "gone": the caller
      // treats `false` as a real failure, which leaves the row for the sweep.
      return false;
    }
  }

  /**
   * Disconnects whatever the role currently holds. BEST EFFORT — see
   * {@link revoke} step 1.
   */
  private async terminateRoleBackends(client: AdminQueryClient, role: string): Promise<void> {
    try {
      await client.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity ' +
          'WHERE usename = $1 AND pid <> pg_backend_pid()',
        [role]
      );
    } catch (error) {
      this.logger.debug(
        `Could not terminate sessions held by ${role} before dropping it (this usually means ` +
          `the application role lacks pg_signal_backend); dropping anyway: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** Undo a role this call created but could not finish granting. */
  private async revokeQuietly(role: string): Promise<void> {
    try {
      await this.revoke(role);
    } catch (error) {
      this.logger.error(
        `⚠ ORPHANED ROLE: created ${role} but could not grant it and could not drop it again. ` +
          `Nothing in this system holds its handle, so only its VALID UNTIL bounds it. Drop it ` +
          `by hand — see ${NODE_JOB_SECRETS_RUNBOOK_PATH}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * The `CREATEROLE` probe, cached for {@link USABLE_CACHE_MS}.
   *
   * NEVER THROWS. An unreachable cluster is a VERDICT here, exactly as it is in
   * `restore-preflight.service.ts`: the caller's job is to refuse a credential
   * with a reason, not to turn an infrastructure problem into a stack trace on
   * a node's request.
   *
   * @param fresh bypasses the cache. Only {@link preflight} passes it — see
   * there for why an operator must not be shown a stale "no".
   */
  private async probe(fresh = false): Promise<ProbeOutcome> {
    const now = Date.now();

    if (!fresh && this.cachedProbe !== null && now - this.cachedProbe.at < USABLE_CACHE_MS) {
      return this.cachedProbe.outcome;
    }

    const connection = this.seam.resolveConnection();
    let outcome: ProbeOutcome;

    try {
      const canCreateRole = await this.seam.withAdminConnection(
        connection,
        (client) => probeCreateRolePrivilege(client),
        { timeoutMs: BROKER_PROBE_TIMEOUT_MS }
      );

      outcome = canCreateRole
        ? { ok: true, reason: '', remedy: '', unreachable: false }
        : {
            ok: false,
            unreachable: false,
            reason:
              `This deployment's database role ("${connection.user}") may not CREATE ROLE, so a ` +
              'short-lived, SELECT-only credential cannot be minted for a worker node. This is ' +
              'the normal configuration on managed PostgreSQL and does not mean anything is ' +
              'broken: the API takes its own backups instead.',
            remedy: buildCreateRoleGrantCommands(connection.user),
          };
    } catch (error) {
      outcome = {
        ok: false,
        unreachable: true,
        reason:
          `The maintenance database "${connection.database}" at ${connection.host}:` +
          `${connection.port} could not be reached, so this deployment's CREATE ROLE privilege ` +
          `could not be checked: ${error instanceof Error ? error.message : String(error)}`,
        remedy:
          `Make ${connection.host}:${connection.port} reachable by this API and confirm the ` +
          `"${connection.database}" maintenance database accepts this role, then try again. ` +
          `See ${NODE_JOB_SECRETS_RUNBOOK_PATH}.`,
      };
    }

    // Cached whether it succeeded or failed. A failing probe is the one most
    // worth caching: it is the case a whole fleet re-asks on every poll, and
    // re-running a failing connection attempt per node per tick is how a
    // database problem becomes a database outage.
    this.cachedProbe = { at: now, outcome };

    return outcome;
  }
}

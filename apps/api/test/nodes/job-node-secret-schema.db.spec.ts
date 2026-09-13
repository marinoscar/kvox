// =============================================================================
// Real-Postgres test: `job_node_secrets` holds a HANDLE and cannot hold a
// SECRET (issue #349, epic #345)
// =============================================================================
//
// THIS IS THE OWNER'S RULE FOR EPIC #345, ASSERTED AGAINST THE ACTUAL DATABASE.
// A worker node never persists a job-scoped credential, and neither does this
// server: the material is serialised into exactly one HTTP response and
// dropped. The reason that rule holds is not a convention anybody has to
// remember — it is that THERE IS NOWHERE TO PUT IT. A column named
// `password`, `secret`, `material`, `dsn`, or the tempting
// `encrypted_material` reusing `SECRETS_ENCRYPTION_KEY`, would each make the
// rule a matter of discipline again, and a credential that can be re-read is a
// credential that can be stolen twice.
//
// Only a real database can prove the column list, and only a real database can
// prove that `@@unique([jobId, kind])` is ENFORCED rather than merely declared
// — a unique constraint that never reached a migration looks identical in the
// Prisma schema and is discovered by a duplicate row in production. So, like
// `worker-node-schema.db.spec.ts` beside it, this is a `*.db.spec.ts`,
// excluded from `npm test` and run by `npm run test:db`.
//
// ⚠ THE COLUMN ASSERTION IS AN ALLOWLIST, NOT A DENYLIST, and that is the
// whole design of this file. A denylist ("no column called `password`") is
// defeated by `cred`, by `blob`, by `x`. An allowlist fails the moment ANY
// column is added, which forces the person adding it to come and read this
// header — which is exactly the conversation that must happen before anything
// new is stored beside a handle.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { buildDatabaseUrl } from '../../src/common/database-url';

/**
 * Every column `job_node_secrets` is allowed to have. See the header: this is
 * an allowlist on purpose, so adding anything at all fails here first.
 */
const PERMITTED_COLUMNS = [
  'expires_at',
  // The grant's identifier — a role name. NEVER the password.
  'handle',
  'id',
  'issued_at',
  'job_id',
  'kind',
  'node_id',
  'revoked_at',
];

/**
 * Substrings that must not appear in any column name.
 *
 * Redundant with the allowlist above and kept anyway, because the FAILURE
 * MESSAGE is the point: an allowlist failure says "unexpected column
 * `encrypted_material`", and this says why that particular name is the one
 * thing this table must never grow.
 */
const FORBIDDEN_NAME_FRAGMENTS = [
  'password',
  'secret',
  'material',
  'credential',
  'token',
  'dsn',
  'encrypted',
  'cipher',
];

/** See `worker-node-schema.db.spec.ts` for the full rationale of this probe. */
function isPostgresReachable(host: string, port: number, timeoutMs = 2000): boolean {
  try {
    const probe = `
      const net = require('net');
      const socket = net.createConnection({ host: process.argv[1], port: Number(process.argv[2]) });
      const done = (ok) => { try { socket.destroy(); } catch (_e) {} process.exit(ok ? 0 : 1); };
      socket.setTimeout(${timeoutMs});
      socket.on('connect', () => done(true));
      socket.on('timeout', () => done(false));
      socket.on('error', () => done(false));
    `;
    execFileSync(process.execPath, ['-e', probe, host, String(port)], {
      stdio: 'ignore',
      timeout: timeoutMs + 1000,
    });
    return true;
  } catch {
    return false;
  }
}

const postgresHost = process.env.POSTGRES_HOST;
const postgresPort = Number(process.env.POSTGRES_PORT) || 5432;
const dbReachable =
  Boolean(postgresHost) && isPostgresReachable(postgresHost as string, postgresPort);

if (!dbReachable) {
  // eslint-disable-next-line no-console
  console.warn(
    `\n[job-node-secret-schema.db.spec] SKIPPED: no Postgres reachable at ` +
      `${postgresHost ?? '(POSTGRES_HOST unset)'}:${postgresPort}. ` +
      `Start infra/compose/test.compose.yml (or otherwise point POSTGRES_HOST/` +
      `POSTGRES_PORT at a migrated database) and re-run \`npm run test:db\`.\n`,
  );
}

const describeWithDb = dbReachable ? describe : describe.skip;

describeWithDb('job_node_secrets schema (real Postgres)', () => {
  let prisma: PrismaClient;

  const KIND = 'test.job-node-secret';

  beforeAll(async () => {
    // `DATABASE_URL` is stripped before rebuilding from POSTGRES_* for the
    // reason `worker-node-schema.db.spec.ts` records: `test/setup.ts` loads a
    // hard-coded one from `.env.test`, and `buildDatabaseUrl()` lets an
    // already-set value win — which would point this suite somewhere other
    // than the host the reachability check just proved.
    const { DATABASE_URL: _ignored, ...envWithoutDatabaseUrl } = process.env;
    prisma = new PrismaClient({
      adapter: new PrismaPg(buildDatabaseUrl(envWithoutDatabaseUrl)),
    });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    await prisma.jobNodeSecret.deleteMany({ where: { kind: KIND } });
  });

  // ===========================================================================
  // ⚠ The column list IS the security property
  // ===========================================================================

  it('has EXACTLY the columns a handle ledger needs — and no more', async () => {
    const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'job_node_secrets'
      ORDER BY column_name
    `;

    // An allowlist, deliberately: adding ANY column fails here, which forces
    // whoever is adding it to read this file's header first.
    expect(rows.map((row) => row.column_name)).toEqual(PERMITTED_COLUMNS);
  });

  it('has no column whose NAME could hold secret material, encrypted or not', async () => {
    const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'job_node_secrets'
    `;

    for (const { column_name: name } of rows) {
      for (const fragment of FORBIDDEN_NAME_FRAGMENTS) {
        // ⚠ Reusing SECRETS_ENCRYPTION_KEY here was considered and REJECTED: a
        // credential that can be re-read is one that can be stolen twice, and
        // nothing needs to re-read this one. Revocation is by handle.
        expect(name).not.toContain(fragment);
      }
    }
  });

  it('stores no bytea/json column that could smuggle a blob past the name check', async () => {
    // The other shape the mistake takes: a `payload jsonb` or a `data bytea`
    // whose NAME says nothing and whose contents are whatever somebody put
    // there. Every column here is a uuid, a text or a timestamptz.
    const rows = await prisma.$queryRaw<Array<{ column_name: string; data_type: string }>>`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'job_node_secrets'
    `;

    const permittedTypes = ['uuid', 'text', 'timestamp with time zone'];

    for (const row of rows) {
      expect(permittedTypes).toContain(row.data_type);
    }
  });

  // ===========================================================================
  // One credential per job, ever — enforced, not merely declared
  // ===========================================================================

  it('refuses a SECOND grant for the same (job, kind)', async () => {
    // The invariant that makes revocation total: both revocation paths know
    // exactly one handle per (job, kind), so a sibling grant would be one
    // nothing ever destroys.
    const jobId = randomUUID();
    const nodeId = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);

    await prisma.jobNodeSecret.create({
      data: { jobId, nodeId, kind: KIND, handle: 'job_reader_1', expiresAt },
    });

    await expect(
      prisma.jobNodeSecret.create({
        data: { jobId, nodeId, kind: KIND, handle: 'job_reader_2', expiresAt },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('still refuses a second grant when the first is already REVOKED', async () => {
    // A revoked row is history, not a free slot. The upsert in
    // `NodeSecretBrokerService.issueForJob` therefore has to clear `revokedAt`
    // on the existing row rather than insert beside it — and this is what makes
    // an insert-shaped implementation impossible to write by accident.
    const jobId = randomUUID();
    const nodeId = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);

    await prisma.jobNodeSecret.create({
      data: {
        jobId,
        nodeId,
        kind: KIND,
        handle: 'job_reader_1',
        expiresAt,
        revokedAt: new Date(),
      },
    });

    await expect(
      prisma.jobNodeSecret.create({
        data: { jobId, nodeId, kind: KIND, handle: 'job_reader_2', expiresAt },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows the same job to hold grants of DIFFERENT kinds', async () => {
    // The unique key is the PAIR. A job type that one day needed a database
    // credential and an object-store credential is a legitimate arrangement;
    // what is refused is two grants of the same kind.
    const jobId = randomUUID();
    const nodeId = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);

    await prisma.jobNodeSecret.create({
      data: { jobId, nodeId, kind: KIND, handle: 'a', expiresAt },
    });
    await prisma.jobNodeSecret.create({
      data: { jobId, nodeId, kind: `${KIND}.other`, handle: 'b', expiresAt },
    });

    const rows = await prisma.jobNodeSecret.findMany({ where: { jobId } });
    expect(rows).toHaveLength(2);

    await prisma.jobNodeSecret.deleteMany({ where: { kind: `${KIND}.other` } });
  });

  // ===========================================================================
  // No FK either way — deliberate, and load-bearing
  // ===========================================================================

  it('accepts a grant for a job id that does not exist', async () => {
    // NO FOREIGN KEY, ON PURPOSE. `jobs` rows are deleted on a retention
    // schedule (`job.history.purge`) that has nothing to do with a grant's
    // lifetime; a cascade from that purge would erase the audit record this
    // table exists to keep, and a restrict would make the purge fail. A grant
    // must also stay revocable after its job row is gone, which is why the
    // sweeper resolves a broker by `kind` rather than by the job's `type`.
    await expect(
      prisma.jobNodeSecret.create({
        data: {
          jobId: randomUUID(),
          nodeId: randomUUID(),
          kind: KIND,
          handle: 'orphan_reader',
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).resolves.toMatchObject({ handle: 'orphan_reader' });
  });

  it('indexes `expires_at`, which is what the sweeper scans', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'job_node_secrets'
    `;

    const names = rows.map((row) => row.indexname);
    expect(names).toContain('job_node_secrets_expires_at_idx');
    expect(names).toContain('job_node_secrets_job_id_kind_key');
  });
});

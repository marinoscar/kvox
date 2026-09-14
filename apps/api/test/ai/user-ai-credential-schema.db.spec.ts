// =============================================================================
// Real-Postgres test: `user_ai_credentials`' constraints (issue #47, epic #45)
// =============================================================================
//
// ⚠ THIS FILE EXISTS BECAUSE THE CASCADE IS THE WHOLE ARGUMENT FOR THE TABLE.
// Issue #47 rejected storing a per-user AI key in the shared `credentials`
// table for one structural reason: that table has no foreign key to `users` and
// cannot grow one, so deleting a user would leave their encrypted PERSONAL API
// key in the database forever with no enumeration path to find it. A cascading
// FK is the entire point — and a foreign key's ON DELETE behaviour only exists
// once a migration has run against a real database. A unit test importing
// `schema.prisma` can read the DECLARATION; it can never prove the DATABASE
// agrees with it, and against the mocked Prisma client a `deleteMany` returns
// whatever the test just told it to.
//
// So, like `note-schema.db.spec.ts` and `transcript-schema.db.spec.ts` beside
// it, this is a `*.db.spec.ts`, deliberately excluded from `npm test` /
// `test:unit` / `test:cov` / `test:ci` (see apps/api/package.json's
// testPathIgnorePatterns). It runs only via `npm run test:db`, against a real
// Postgres with this migration applied.
//
// What it asserts:
//   - Deleting a user CASCADES their `user_ai_credentials` rows away, verified
//     by reading the table back — the issue's own acceptance criterion,
//     "verified against the database and not just the API".
//   - Deleting the CREDENTIAL leaves the user alone (the cascade has one
//     direction, and asserting only the first half would pass for a schema
//     that deleted the user too).
//   - `(user_id, provider)` is UNIQUE, so a replace is an upsert on one row and
//     never a second row accumulating stale key material.
//   - Two DIFFERENT users may each hold a key for the same provider — which is
//     the whole point of a per-user credential and the thing a unique index on
//     `provider` alone would break.
//   - `secret` is `text`, not a bounded varchar: a truncating column type would
//     corrupt a credential at write time and fail authentication at read time,
//     with nothing to connect the two events.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { buildDatabaseUrl } from '../../src/common/database-url';

/**
 * Whether something is actually listening on host:port. Copied verbatim from
 * `note-schema.db.spec.ts` / `transcript-schema.db.spec.ts` rather than shared,
 * matching those files' own precedent of being self-contained.
 */
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
    `\n[user-ai-credential-schema.db.spec] SKIPPED: no Postgres reachable at ` +
      `${postgresHost ?? '(POSTGRES_HOST unset)'}:${postgresPort}. ` +
      `Start infra/compose/test.compose.yml (or otherwise point POSTGRES_HOST/` +
      `POSTGRES_PORT at a migrated database) and re-run \`npm run test:db\` ` +
      `to exercise these real-Postgres assertions.\n`,
  );
}

const describeWithDb = dbReachable ? describe : describe.skip;

describeWithDb('user_ai_credentials schema (real Postgres)', () => {
  let prisma: PrismaClient;

  const EMAIL_PREFIX = 'ai-cred-schema-test';

  /**
   * A value that LOOKS like a secret but is not one.
   *
   * The rows here never hold a real ciphertext — this file is about the
   * CONSTRAINTS, not the cipher, and `secret-cipher.spec.ts` owns the
   * encryption. A recognisable literal also makes a stray row easy to find if a
   * cleanup ever fails.
   */
  const FAKE_CIPHERTEXT = 'not-a-real-ciphertext-schema-test';

  beforeAll(async () => {
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
    // Users last — the cascade removes the credentials with them, but an
    // explicit delete first keeps a failed assertion from leaving rows behind.
    await prisma.userAiCredential.deleteMany({
      where: { user: { email: { startsWith: EMAIL_PREFIX } } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  async function createUser(suffix: string) {
    return prisma.user.create({
      data: {
        email: `${EMAIL_PREFIX}-${suffix}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2)}@example.test`,
      },
    });
  }

  // ===========================================================================
  // user_id CASCADE — the reason this table exists
  // ===========================================================================

  describe('users -> user_ai_credentials CASCADE', () => {
    it('deleting a user removes their user_ai_credentials row', async () => {
      const user = await createUser('cascade');

      const credential = await prisma.userAiCredential.create({
        data: {
          userId: user.id,
          provider: 'openai',
          secret: FAKE_CIPHERTEXT,
          hint: '••••1234',
          label: 'work',
        },
      });

      // It exists before the delete, so a passing assertion below cannot be
      // "there was never a row".
      expect(
        await prisma.userAiCredential.findUnique({ where: { id: credential.id } }),
      ).not.toBeNull();

      await prisma.user.delete({ where: { id: user.id } });

      // ⚠ READ BACK FROM THE DATABASE, not inferred from the delete's return
      // value. This is the assertion the whole table design rests on: without
      // the cascade, an encrypted personal API key would outlive its owner's
      // account with nothing able to find it again.
      expect(
        await prisma.userAiCredential.findUnique({ where: { id: credential.id } }),
      ).toBeNull();
      expect(
        await prisma.userAiCredential.count({ where: { userId: user.id } }),
      ).toBe(0);
    });

    it('cascades every one of a user\'s credentials, not merely the first', async () => {
      const user = await createUser('cascade-many');

      // Two providers for one user. `openai` is the only registered one today;
      // the column is a plain string precisely so a fork can register another,
      // and the cascade must not depend on how many rows there are.
      await prisma.userAiCredential.createMany({
        data: [
          { userId: user.id, provider: 'openai', secret: FAKE_CIPHERTEXT },
          { userId: user.id, provider: 'some-other-vendor', secret: FAKE_CIPHERTEXT },
        ],
      });

      await prisma.user.delete({ where: { id: user.id } });

      expect(
        await prisma.userAiCredential.count({ where: { userId: user.id } }),
      ).toBe(0);
    });

    it('has ONE direction — deleting the credential leaves the user alone', async () => {
      const user = await createUser('cascade-direction');

      const credential = await prisma.userAiCredential.create({
        data: { userId: user.id, provider: 'openai', secret: FAKE_CIPHERTEXT },
      });

      await prisma.userAiCredential.delete({ where: { id: credential.id } });

      // Asserting only the first half would pass for a schema that cascaded
      // both ways, which would make "remove my AI key" delete the account.
      expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
    });
  });

  // ===========================================================================
  // (user_id, provider) UNIQUE
  // ===========================================================================

  describe('@@unique([userId, provider])', () => {
    it('refuses a second row for the same user and provider', async () => {
      const user = await createUser('unique');

      await prisma.userAiCredential.create({
        data: { userId: user.id, provider: 'openai', secret: FAKE_CIPHERTEXT },
      });

      // Without this constraint, a "replace my key" that raced with itself
      // would leave two rows and the reader would pick one arbitrarily — which
      // means a rotated-away key could keep being used.
      await expect(
        prisma.userAiCredential.create({
          data: { userId: user.id, provider: 'openai', secret: 'a-second-value' },
        }),
      ).rejects.toThrow();
    });

    it('lets an upsert on the pair REPLACE in place rather than accumulate', async () => {
      const user = await createUser('upsert');

      await prisma.userAiCredential.create({
        data: {
          userId: user.id,
          provider: 'openai',
          secret: FAKE_CIPHERTEXT,
          hint: '••••1111',
        },
      });

      await prisma.userAiCredential.upsert({
        where: { userId_provider: { userId: user.id, provider: 'openai' } },
        create: { userId: user.id, provider: 'openai', secret: 'replaced', hint: '••••2222' },
        update: { secret: 'replaced', hint: '••••2222' },
      });

      const rows = await prisma.userAiCredential.findMany({
        where: { userId: user.id },
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].hint).toBe('••••2222');
    });

    it('lets TWO DIFFERENT users each hold a key for the same provider', async () => {
      const alice = await createUser('shared-provider-a');
      const bob = await createUser('shared-provider-b');

      await prisma.userAiCredential.create({
        data: { userId: alice.id, provider: 'openai', secret: FAKE_CIPHERTEXT },
      });

      // The whole point of a PER-USER credential, and precisely what a unique
      // index on `provider` alone would have broken.
      await expect(
        prisma.userAiCredential.create({
          data: { userId: bob.id, provider: 'openai', secret: FAKE_CIPHERTEXT },
        }),
      ).resolves.toMatchObject({ provider: 'openai' });
    });
  });

  // ===========================================================================
  // Column types
  // ===========================================================================

  describe('column shapes', () => {
    it('stores `secret` as unbounded text', async () => {
      const [column] = await prisma.$queryRawUnsafe<
        Array<{ data_type: string; character_maximum_length: number | null }>
      >(
        `SELECT data_type, character_maximum_length
           FROM information_schema.columns
          WHERE table_name = 'user_ai_credentials' AND column_name = 'secret'`,
      );

      // A base64 AES-GCM payload has no meaningful bound. A truncating column
      // type would corrupt a credential at write time and fail authentication
      // at read time, with nothing to connect the two events.
      expect(column.data_type).toBe('text');
      expect(column.character_maximum_length).toBeNull();
    });

    it('accepts a large ciphertext without truncation', async () => {
      const user = await createUser('long-secret');
      const long = 'A'.repeat(8000);

      const created = await prisma.userAiCredential.create({
        data: { userId: user.id, provider: 'openai', secret: long },
      });

      const read = await prisma.userAiCredential.findUnique({
        where: { id: created.id },
      });

      expect(read?.secret).toHaveLength(8000);
    });

    it('leaves hint, label and lastUsedAt nullable', async () => {
      const user = await createUser('nullable');

      // A fresh row before anything has used the key, and a short key with no
      // suffix worth revealing, are both ordinary states — not errors.
      const created = await prisma.userAiCredential.create({
        data: { userId: user.id, provider: 'openai', secret: FAKE_CIPHERTEXT },
      });

      expect(created.hint).toBeNull();
      expect(created.label).toBeNull();
      expect(created.lastUsedAt).toBeNull();
    });
  });
});

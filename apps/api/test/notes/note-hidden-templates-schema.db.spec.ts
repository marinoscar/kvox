// =============================================================================
// Real-Postgres test: `user_hidden_note_templates` cascade behaviour (#310)
// =============================================================================
//
// A foreign key's ON DELETE behaviour only exists once a migration has run
// against a real database — a unit test importing `schema.prisma` can read
// the DECLARATION, never prove the DATABASE agrees with it. So, like
// `note-schema.db.spec.ts` beside it, this is a `*.db.spec.ts` file,
// deliberately excluded from `npm test`/`test:unit`/`test:cov`/`test:ci` (see
// apps/api/package.json's testPathIgnorePatterns). It runs only via
// `npm run test:db`, against a real Postgres with this migration applied.
//
// What this file asserts, and why each is the constraint the block comment
// above `UserHiddenNoteTemplate` in schema.prisma names:
//   - Deleting a USER cascades away every `user_hidden_note_templates` row
//     they created (hiding is per-user; a deleted user's hides are meaningless).
//   - Deleting a TEMPLATE cascades away every `user_hidden_note_templates` row
//     that named it (a hide of a template that no longer exists is meaningless),
//     regardless of whether the deleted template was a built-in or a user's
//     own custom row.
//   - `@@id([userId, templateId])` is enforced: a second hide of the same
//     pair is a no-op at the application layer (`upsert`), and this file
//     proves the underlying constraint a raw double-insert would hit.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { buildDatabaseUrl } from '../../src/common/database-url';

/** Copied verbatim from `note-schema.db.spec.ts`'s own precedent. */
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
    `\n[note-hidden-templates-schema.db.spec] SKIPPED: no Postgres reachable at ` +
      `${postgresHost ?? '(POSTGRES_HOST unset)'}:${postgresPort}. ` +
      `Start infra/compose/test.compose.yml (or otherwise point POSTGRES_HOST/` +
      `POSTGRES_PORT at a migrated database) and re-run \`npm run test:db\` ` +
      `to exercise these real-Postgres assertions.\n`,
  );
}

const describeWithDb = dbReachable ? describe : describe.skip;

describeWithDb('user_hidden_note_templates schema (real Postgres)', () => {
  let prisma: PrismaClient;

  const EMAIL_PREFIX = 'hidden-template-test';

  beforeAll(async () => {
    const { DATABASE_URL: _ignored, ...envWithoutDatabaseUrl } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(envWithoutDatabaseUrl)) });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    await prisma.userHiddenNoteTemplate.deleteMany({
      where: { template: { name: { startsWith: 'test-hidden-template-' } } },
    });
    await prisma.noteTemplate.deleteMany({
      where: { name: { startsWith: 'test-hidden-template-' } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  async function createUser(suffix: string) {
    return prisma.user.create({
      data: {
        email: `${EMAIL_PREFIX}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      },
    });
  }

  async function createTemplate(suffix: string, ownerId: string | null = null) {
    return prisma.noteTemplate.create({
      data: {
        ownerId,
        name: `test-hidden-template-${suffix}`,
        description: 'A template for hide/cascade tests',
        instructions: 'Summarize the meeting.',
        outputFormat: 'meeting_notes',
        structure: ['Overview'],
      },
    });
  }

  // ===========================================================================
  // @@id([userId, templateId])
  // ===========================================================================

  describe('primary key', () => {
    it('rejects a second row for the same (userId, templateId) pair', async () => {
      const user = await createUser('pk-user');
      const template = await createTemplate('pk', null);

      await prisma.userHiddenNoteTemplate.create({
        data: { userId: user.id, templateId: template.id },
      });

      await expect(
        prisma.userHiddenNoteTemplate.create({
          data: { userId: user.id, templateId: template.id },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('allows the SAME template to be hidden by two DIFFERENT users independently', async () => {
      const userA = await createUser('pair-a');
      const userB = await createUser('pair-b');
      const template = await createTemplate('pair', null);

      await expect(
        prisma.userHiddenNoteTemplate.create({ data: { userId: userA.id, templateId: template.id } }),
      ).resolves.toMatchObject({ userId: userA.id, templateId: template.id });
      await expect(
        prisma.userHiddenNoteTemplate.create({ data: { userId: userB.id, templateId: template.id } }),
      ).resolves.toMatchObject({ userId: userB.id, templateId: template.id });
    });
  });

  // ===========================================================================
  // users -> user_hidden_note_templates CASCADE
  // ===========================================================================

  describe('users -> user_hidden_note_templates CASCADE', () => {
    it('deleting a user cascades away every hide they created', async () => {
      const user = await createUser('user-cascade');
      // A built-in (ownerId null) is exactly the row #310 exists to let a
      // user hide, so this is deliberately not the user's own template.
      const builtIn = await createTemplate('user-cascade-builtin', null);

      const hide = await prisma.userHiddenNoteTemplate.create({
        data: { userId: user.id, templateId: builtIn.id },
      });

      await prisma.user.delete({ where: { id: user.id } });

      await expect(
        prisma.userHiddenNoteTemplate.findUnique({
          where: { userId_templateId: { userId: hide.userId, templateId: hide.templateId } },
        }),
      ).resolves.toBeNull();

      // The built-in template itself is untouched — hiding is per-user, and
      // a user's own deletion must never delete a shared row.
      await expect(
        prisma.noteTemplate.findUnique({ where: { id: builtIn.id } }),
      ).resolves.toMatchObject({ id: builtIn.id });
    });
  });

  // ===========================================================================
  // note_templates -> user_hidden_note_templates CASCADE
  // ===========================================================================

  describe('note_templates -> user_hidden_note_templates CASCADE', () => {
    it('deleting a BUILT-IN template cascades away every hide of it', async () => {
      const user = await createUser('template-cascade-builtin');
      const builtIn = await createTemplate('template-cascade-builtin', null);

      const hide = await prisma.userHiddenNoteTemplate.create({
        data: { userId: user.id, templateId: builtIn.id },
      });

      await prisma.noteTemplate.delete({ where: { id: builtIn.id } });

      await expect(
        prisma.userHiddenNoteTemplate.findUnique({
          where: { userId_templateId: { userId: hide.userId, templateId: hide.templateId } },
        }),
      ).resolves.toBeNull();
    });

    it('deleting a user\'s OWN custom template cascades away every hide of it', async () => {
      const owner = await createUser('template-cascade-owner');
      const hider = await createUser('template-cascade-hider');
      const custom = await createTemplate('template-cascade-custom', owner.id);

      // Nothing stops a user from hiding somebody ELSE's readable template —
      // hiding is per-user and unrelated to ownership.
      const hide = await prisma.userHiddenNoteTemplate.create({
        data: { userId: hider.id, templateId: custom.id },
      });

      await prisma.noteTemplate.delete({ where: { id: custom.id } });

      await expect(
        prisma.userHiddenNoteTemplate.findUnique({
          where: { userId_templateId: { userId: hide.userId, templateId: hide.templateId } },
        }),
      ).resolves.toBeNull();
    });
  });
});

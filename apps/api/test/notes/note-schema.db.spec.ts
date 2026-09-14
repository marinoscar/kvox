// =============================================================================
// Real-Postgres test: the notes data model's constraints (issue #48, epic #45)
// =============================================================================
//
// A foreign key's ON DELETE behaviour and a unique constraint's actual
// enforcement only exist once a migration has run against a real database —
// a unit test importing `schema.prisma` can read the DECLARATION, never
// prove the DATABASE agrees with it. So, like `transcript-schema.db.spec.ts`
// beside it, this is a `*.db.spec.ts` file, deliberately excluded from
// `npm test`/`test:unit`/`test:cov`/`test:ci` (see apps/api/package.json's
// testPathIgnorePatterns). It runs only via `npm run test:db`, against a
// real Postgres with this migration applied.
//
// What this file asserts, and why each one is the constraint issue #48's own
// acceptance criteria name:
//   - Deleting a user CASCADES their notes, note_versions, note_templates
//     (owned ones) and note_generations away.
//   - Deleting a transcript that a note names as its source is REFUSED
//     while the note exists (Restrict), and succeeds once the note itself
//     is deleted — the test asserts the DIRECTION, not just that an error
//     occurred.
//   - `(note_id, version)` unique on `note_versions` — two rows with the
//     same pair are rejected.
//   - `(note_id, client_batch_id)` unique on `note_versions`, with NULLs
//     free to repeat.
//   - Seeding the six built-in note templates twice yields one copy of
//     each, and does not modify a user's duplicated copy.
//   - `note_exports`' content-addressed lookup index exists and is a plain,
//     NON-unique index (matching `transcript_exports_lookup_idx`'s real
//     shape, not spec §4.6's shorthand "unique" wording — see the block
//     comment above the `NoteExport` model in schema.prisma).
// =============================================================================

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { buildDatabaseUrl } from '../../src/common/database-url';
import { NOTE_TEMPLATES } from '../../prisma/seed-data';

/**
 * Whether something is actually listening on host:port. Copied verbatim
 * from `transcript-schema.db.spec.ts` / `job-schema-indexes.db.spec.ts`
 * rather than shared, matching those files' own precedent of being
 * self-contained.
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
    `\n[note-schema.db.spec] SKIPPED: no Postgres reachable at ` +
      `${postgresHost ?? '(POSTGRES_HOST unset)'}:${postgresPort}. ` +
      `Start infra/compose/test.compose.yml (or otherwise point POSTGRES_HOST/` +
      `POSTGRES_PORT at a migrated database) and re-run \`npm run test:db\` ` +
      `to exercise these real-Postgres assertions.\n`,
  );
}

const describeWithDb = dbReachable ? describe : describe.skip;

describeWithDb('Notes schema (real Postgres)', () => {
  let prisma: PrismaClient;

  const EMAIL_PREFIX = 'note-schema-test';

  beforeAll(async () => {
    const { DATABASE_URL: _ignored, ...envWithoutDatabaseUrl } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(envWithoutDatabaseUrl)) });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    // Children first, notes next, transcripts/objects, users last.
    await prisma.noteExport.deleteMany({ where: { note: { title: { startsWith: 'test-note-' } } } });
    await prisma.noteVersion.deleteMany({ where: { note: { title: { startsWith: 'test-note-' } } } });
    await prisma.note.updateMany({
      where: { title: { startsWith: 'test-note-' } },
      data: { currentGenerationId: null },
    });
    await prisma.noteGeneration.deleteMany({ where: { note: { title: { startsWith: 'test-note-' } } } });
    await prisma.note.deleteMany({ where: { title: { startsWith: 'test-note-' } } });
    await prisma.noteTemplate.deleteMany({
      where: { name: { startsWith: 'test-note-template-' } },
    });
    await prisma.transcript.deleteMany({ where: { title: { startsWith: 'test-note-schema-' } } });
    await prisma.storageObject.deleteMany({
      where: { storageKey: { startsWith: 'test-note-schema/' } },
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

  async function createSourceObject(uploadedById: string, suffix: string) {
    return prisma.storageObject.create({
      data: {
        name: 'document.pdf',
        size: BigInt(1024),
        mimeType: 'application/pdf',
        storageKey: `test-note-schema/${suffix}-${randomUUID()}`,
        managedBy: 'notes',
        uploadedById,
      },
    });
  }

  async function createTranscript(ownerId: string, sourceObjectId: string, suffix: string) {
    return prisma.transcript.create({
      data: {
        ownerId,
        title: `test-note-schema-${suffix}`,
        sourceObjectId,
        provider: 'assemblyai',
      },
    });
  }

  async function createNoteFromTranscript(ownerId: string, transcriptId: string, suffix: string) {
    return prisma.note.create({
      data: {
        ownerId,
        title: `test-note-${suffix}`,
        sourceType: 'transcript',
        sourceTranscriptId: transcriptId,
      },
    });
  }

  // ===========================================================================
  // owner_id CASCADE
  // ===========================================================================

  describe('users -> notes/note_templates/note_versions/note_generations CASCADE', () => {
    it('deleting a user cascades their notes, versions, owned templates and generations away', async () => {
      const owner = await createUser('cascade-owner');
      const source = await createSourceObject(owner.id, 'cascade');
      const transcript = await createTranscript(owner.id, source.id, 'cascade');
      const note = await createNoteFromTranscript(owner.id, transcript.id, 'cascade');

      const template = await prisma.noteTemplate.create({
        data: {
          ownerId: owner.id,
          name: 'test-note-template-cascade',
          description: 'A custom template',
          instructions: 'Summarize the meeting.',
          outputFormat: 'meeting_notes',
          structure: ['Overview', 'Decisions'],
        },
      });

      const generation = await prisma.noteGeneration.create({
        data: {
          noteId: note.id,
          kind: 'create',
          templateNameSnapshot: template.name,
          sourceType: 'transcript',
          sourceTranscriptId: transcript.id,
          providerId: 'openai',
          model: 'gpt-4o',
        },
      });

      await prisma.noteVersion.create({
        data: {
          noteId: note.id,
          version: 1,
          kind: 'ai_generated',
          body: '# Notes',
          generationId: generation.id,
        },
      });

      // Clear the FK cycle first, then delete the owner directly (bypassing
      // any application-layer purge flow, exactly like
      // transcript-schema.db.spec.ts does for its own cascade test).
      await prisma.note.update({ where: { id: note.id }, data: { currentGenerationId: null } });
      await prisma.transcript.delete({ where: { id: transcript.id } }).catch(() => {
        // May still be blocked by the note's Restrict FK — deleted below via
        // the note first in the real flow; irrelevant to this assertion,
        // which only cares about the user cascade below.
      });

      await prisma.user.delete({ where: { id: owner.id } });

      await expect(prisma.note.findUnique({ where: { id: note.id } })).resolves.toBeNull();
      await expect(
        prisma.noteVersion.findFirst({ where: { noteId: note.id } }),
      ).resolves.toBeNull();
      await expect(
        prisma.noteGeneration.findFirst({ where: { noteId: note.id } }),
      ).resolves.toBeNull();
      await expect(
        prisma.noteTemplate.findUnique({ where: { id: template.id } }),
      ).resolves.toBeNull();
    });
  });

  // ===========================================================================
  // source_transcript_id RESTRICT — the direction, not just "an error"
  // ===========================================================================

  describe('transcripts -> notes.source_transcript_id RESTRICT', () => {
    it('refuses to delete a transcript while a note still names it as source, and succeeds once the note is gone', async () => {
      const owner = await createUser('restrict-owner');
      const source = await createSourceObject(owner.id, 'restrict');
      const transcript = await createTranscript(owner.id, source.id, 'restrict');
      const note = await createNoteFromTranscript(owner.id, transcript.id, 'restrict');

      // REFUSED while the note exists — asserting the actual FK error code,
      // not merely "something threw".
      await expect(prisma.transcript.delete({ where: { id: transcript.id } })).rejects.toMatchObject(
        { code: 'P2003' },
      );

      // SUCCEEDS once the note is gone — proves the direction: it is the
      // note's reference that blocks the transcript, not the reverse.
      await prisma.note.delete({ where: { id: note.id } });
      await expect(
        prisma.transcript.delete({ where: { id: transcript.id } }),
      ).resolves.toMatchObject({ id: transcript.id });
    });
  });

  // ===========================================================================
  // note_versions: (note_id, version) and (note_id, client_batch_id)
  // ===========================================================================

  describe('note_versions uniqueness', () => {
    it('rejects a second row with the same (noteId, version)', async () => {
      const owner = await createUser('version-owner');
      const source = await createSourceObject(owner.id, 'version');
      const transcript = await createTranscript(owner.id, source.id, 'version');
      const note = await createNoteFromTranscript(owner.id, transcript.id, 'version');

      await prisma.noteVersion.create({
        data: { noteId: note.id, version: 1, kind: 'ai_generated', body: 'v1' },
      });

      await expect(
        prisma.noteVersion.create({
          data: { noteId: note.id, version: 1, kind: 'edit', body: 'v1 again' },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('rejects a second row with the same (noteId, clientBatchId)', async () => {
      const owner = await createUser('batch-owner');
      const source = await createSourceObject(owner.id, 'batch');
      const transcript = await createTranscript(owner.id, source.id, 'batch');
      const note = await createNoteFromTranscript(owner.id, transcript.id, 'batch');

      await prisma.noteVersion.create({
        data: {
          noteId: note.id,
          version: 1,
          kind: 'edit',
          body: 'v1',
          clientBatchId: 'batch-1',
        },
      });

      await expect(
        prisma.noteVersion.create({
          data: {
            noteId: note.id,
            version: 2,
            kind: 'edit',
            body: 'v2',
            clientBatchId: 'batch-1',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('allows MANY versions with a null clientBatchId on the same note (NULLS DISTINCT)', async () => {
      const owner = await createUser('null-batch-owner');
      const source = await createSourceObject(owner.id, 'null-batch');
      const transcript = await createTranscript(owner.id, source.id, 'null-batch');
      const note = await createNoteFromTranscript(owner.id, transcript.id, 'null-batch');

      await expect(
        prisma.noteVersion.create({
          data: { noteId: note.id, version: 1, kind: 'ai_generated', body: 'v1' },
        }),
      ).resolves.toMatchObject({ clientBatchId: null });
      await expect(
        prisma.noteVersion.create({
          data: { noteId: note.id, version: 2, kind: 'restore', body: 'v2' },
        }),
      ).resolves.toMatchObject({ clientBatchId: null });
    });
  });

  // ===========================================================================
  // note_exports: content-addressed lookup index exists and is NON-unique
  // ===========================================================================

  describe('note_exports lookup index', () => {
    it('creates a plain, non-unique index — a fresh export may coexist with an expired/failed one sharing the same key', async () => {
      const rows = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'note_exports' AND indexname = 'note_exports_lookup_idx'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef.toUpperCase()).not.toContain('UNIQUE');
    });

    it('actually allows two note_exports rows sharing (noteId, version, format, optionsHash)', async () => {
      const owner = await createUser('export-owner');
      const source = await createSourceObject(owner.id, 'export');
      const transcript = await createTranscript(owner.id, source.id, 'export');
      const note = await createNoteFromTranscript(owner.id, transcript.id, 'export');

      const shared = {
        noteId: note.id,
        version: 1,
        format: 'markdown',
        options: {},
        optionsHash: 'deadbeef',
        requestedById: owner.id,
        expiresAt: new Date(Date.now() + 1000 * 60),
      };

      await expect(
        prisma.noteExport.create({ data: { ...shared, status: 'failed' } }),
      ).resolves.toBeDefined();
      await expect(
        prisma.noteExport.create({ data: { ...shared, status: 'pending' } }),
      ).resolves.toBeDefined();
    });
  });

  // ===========================================================================
  // Built-in note template seed idempotency
  // ===========================================================================

  describe('built-in note template seed idempotency', () => {
    async function upsertBuiltins() {
      for (const template of NOTE_TEMPLATES) {
        await prisma.noteTemplate.upsert({
          where: { id: template.id },
          update: {
            name: template.name,
            description: template.description,
            instructions: template.instructions,
            outputFormat: template.outputFormat,
            structure: template.structure,
            tone: template.tone,
            length: template.length,
          },
          create: {
            id: template.id,
            ownerId: null,
            name: template.name,
            description: template.description,
            instructions: template.instructions,
            outputFormat: template.outputFormat,
            structure: template.structure,
            tone: template.tone,
            length: template.length,
          },
        });
      }
    }

    afterEach(async () => {
      await prisma.noteTemplate.deleteMany({
        where: { id: { in: NOTE_TEMPLATES.map((t) => t.id) } },
      });
    });

    it('running the built-in seed twice yields exactly one row per built-in', async () => {
      await upsertBuiltins();
      await upsertBuiltins();

      const rows = await prisma.noteTemplate.findMany({
        where: { id: { in: NOTE_TEMPLATES.map((t) => t.id) } },
      });
      expect(rows).toHaveLength(NOTE_TEMPLATES.length);
      expect(rows.every((row) => row.ownerId === null)).toBe(true);
    });

    it('does not modify a user\'s duplicated copy of a built-in', async () => {
      await upsertBuiltins();

      const owner = await createUser('duplicate-owner');
      const original = NOTE_TEMPLATES[0];

      // The duplicate-to-mine flow (spec §7.3): a fresh row, a fresh id,
      // owner set, name suffixed.
      const duplicate = await prisma.noteTemplate.create({
        data: {
          ownerId: owner.id,
          name: `${original.name} (copy)`,
          description: original.description,
          instructions: 'A customised version the user has since edited.',
          outputFormat: original.outputFormat,
          structure: original.structure,
          tone: original.tone,
          length: original.length,
        },
      });

      // Re-running the built-in seed must never touch the duplicate — it
      // upserts on the built-in's own fixed id, which the duplicate never
      // shares.
      await upsertBuiltins();

      const stillThere = await prisma.noteTemplate.findUnique({ where: { id: duplicate.id } });
      expect(stillThere?.instructions).toBe('A customised version the user has since edited.');
      expect(stillThere?.ownerId).toBe(owner.id);

      await prisma.noteTemplate.delete({ where: { id: duplicate.id } });
    });
  });
});

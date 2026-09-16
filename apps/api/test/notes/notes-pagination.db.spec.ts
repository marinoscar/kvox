// =============================================================================
// Real-Postgres test: cursor paging over a list that moves (issue #53, epic #45)
// =============================================================================
//
// ⚠ THE ACCEPTANCE CRITERION THIS FILE IS: "cursor paging over a list mutated
// mid-pagination neither skips nor repeats a row."
//
// It is a `*.db.spec.ts` — excluded from `npm test` and run only by
// `npm run test:db` — because a keyset that neither skips nor repeats is a
// statement about what PostgreSQL returns for a compound `(updated_at, id)`
// predicate, not about what a mock was told to return. Mocking the query away
// would leave the one interesting question untested.
//
// -----------------------------------------------------------------------------
// WHAT "MUTATED MID-PAGINATION" MEANS HERE, AND WHY IT IS THE ORDINARY CASE
// -----------------------------------------------------------------------------
//
// A note's `updated_at` moves on EVERY generation and EVERY save — which, in a
// notes library, is exactly what happens while somebody scrolls it: a note
// finishes generating, or another tab saves an edit. The row jumps to the top
// of an `updated_at desc` ordering, and every row after it shifts down by one.
//
// Under OFFSET paging that shift is a silent defect: page 2 starts at row n of
// a list whose first n rows are no longer the first n rows, so a row already
// served on page 1 is served AGAIN. This file asserts the keyset does not do
// that AND, in the same test, computes what the equivalent offset query would
// have returned — so the test states the bug it exists to prevent rather than
// merely asserting the fix.
//
// ⚠ WHAT A KEYSET PROMISES, STATED PRECISELY, because the second test asserts
// exactly this and it would otherwise read as a hole: it never serves a row
// twice, and never drops a row that did not move. A row a WRITER moves from
// below the reader's cursor to the top of the list is not served again in that
// pass — it now sits in the region the reader already read, where they will
// find it the next time they open the list. No pagination scheme orders by a
// column writers keep changing and also promises to re-serve a row that moved
// backwards past the cursor; offset does not manage it either, and pays for the
// attempt with duplicates.
//
// The second assertion here is the one issue #50 could not make for itself: a
// PREVIEW generation (`note_id: NULL`) is invisible to `GET /api/notes`. Proved
// with a real preview row in the table, because "the list reads `notes` and a
// preview is not in `notes`" is a claim about a schema, and a schema is what a
// real database has.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { buildDatabaseUrl } from '../../src/common/database-url';
import type { NotesService } from '../../src/notes/notes.service';
import { buildNotesService } from './notes-service-test-factory';

/**
 * Whether something is actually listening on host:port. Copied verbatim from
 * `note-schema.db.spec.ts`, matching that file's own precedent of being
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
    `\n[notes-pagination.db.spec] SKIPPED: no Postgres reachable at ` +
      `${postgresHost ?? '(POSTGRES_HOST unset)'}:${postgresPort}.\n`,
  );
}

const describeWithDb = dbReachable ? describe : describe.skip;

describeWithDb('Note list paging (real Postgres)', () => {
  let prisma: PrismaClient;
  let notes: NotesService;

  const EMAIL_PREFIX = 'note-paging-test';
  const TITLE_PREFIX = 'test-paging-note-';

  beforeAll(async () => {
    const { DATABASE_URL: _ignored, ...envWithoutDatabaseUrl } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(envWithoutDatabaseUrl)) });
    await prisma.$connect();

    // ⚠ CONSTRUCTED WITH ONLY THE COLLABORATOR THE EXERCISED PATH USES.
    // `NotesService.list` reads `this.prisma` and nothing else; handing it real
    // stand-ins for the six other services it never calls would obscure that
    // rather than prove anything. Every other method is out of scope for this
    // file. Named by role (see `notes-service-test-factory.ts`) so no argument
    // can land in the wrong slot the way #224's did.
    notes = buildNotesService({
      prisma: prisma as never,
      access: null as never, // `list` never reaches it
      sourceNames: null as never, // `list` never reaches it
      templates: null as never, // `list` never reaches it
      requests: null as never, // `list` never reaches it
      sources: null as never, // `list` never reaches it
      jobs: null as never, // `list` never reaches it
      // #188's semantic indexer — `null` like the rest, for the same reason the
      // ⚠ above gives: `list` never reaches it.
      searchIndex: null as never,
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    await prisma.noteGeneration.deleteMany({
      where: { templateNameSnapshot: { startsWith: TITLE_PREFIX } },
    });
    await prisma.note.deleteMany({ where: { title: { startsWith: TITLE_PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  async function createUser() {
    return prisma.user.create({
      data: {
        email: `${EMAIL_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      },
    });
  }

  /** Ten notes, one minute apart, newest last. */
  async function seed(ownerId: string, count = 10) {
    const created: string[] = [];

    for (let index = 0; index < count; index += 1) {
      const note = await prisma.note.create({
        data: {
          ownerId,
          title: `${TITLE_PREFIX}${index}`,
          sourceType: 'note',
          body: `Body ${index}`,
          // Explicit timestamps: `@updatedAt` would make every row share a
          // millisecond and turn the tie-break into the only thing being
          // tested.
          updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
        },
      });

      created.push(note.id);
    }

    return created;
  }

  it('serves every remaining row exactly once when an ALREADY-READ row is saved', async () => {
    const owner = await createUser();
    const ids = await seed(owner.id);

    const limit = 3;
    const seen: string[] = [];

    const first = await notes.list({ limit } as never, owner.id);

    seen.push(...first.items.map((item) => item.id));

    expect(first.items).toHaveLength(limit);

    // The ordinary case: a note the reader has already scrolled past finishes
    // regenerating, or another tab saves an edit to it. It moves WITHIN the
    // region already read.
    await prisma.note.update({
      where: { id: seen[2] },
      data: { updatedAt: new Date(Date.UTC(2026, 0, 2)) },
    });

    let cursor: string | null = first.nextCursor;

    while (cursor) {
      const page = await notes.list({ limit, cursor } as never, owner.id);

      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    }

    // NEITHER REPEATED...
    expect(new Set(seen).size).toBe(seen.length);
    // ...NOR SKIPPED: all ten, every one exactly once.
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it('does not repeat a row when an UNREAD one jumps to the top — which is exactly what offset does', async () => {
    const owner = await createUser();
    const ids = await seed(owner.id);

    const limit = 3;
    const seen: string[] = [];

    const first = await notes.list({ limit } as never, owner.id);

    seen.push(...first.items.map((item) => item.id));

    // ⚠ THE MUTATION OFFSET PAGING CANNOT SURVIVE: a note the reader has NOT
    // reached yet is saved, so it jumps to the top and every unread row below
    // it shifts DOWN by one.
    const jumped = ids[4];

    await prisma.note.update({
      where: { id: jumped },
      data: { updatedAt: new Date(Date.UTC(2026, 0, 2)) },
    });

    // What OFFSET page 2 would now return — the defect, stated rather than
    // merely avoided: its first row was already served on page 1, because the
    // shift pushed it across the page boundary.
    const offsetPage2 = await prisma.note.findMany({
      where: { ownerId: owner.id, deletedAt: null },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: limit,
      take: limit,
    });

    expect(seen).toContain(offsetPage2[0].id);

    let cursor: string | null = first.nextCursor;

    while (cursor) {
      const page = await notes.list({ limit, cursor } as never, owner.id);

      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    }

    // THE KEYSET REPEATS NOTHING.
    expect(new Set(seen).size).toBe(seen.length);

    // And it serves every row whose position the reader had not already passed.
    // The one row not served is the one the WRITER moved above the reader —
    // which is a property of "newest first", not of the pager: it now sits at
    // the top of the list, where the reader will find it the next time they
    // open it. No pagination scheme orders a list by a column a writer keeps
    // changing and also promises to serve a row that moved backwards past the
    // cursor; what a keyset promises, and delivers here, is that it never
    // serves one TWICE and never drops one that did not move.
    expect(new Set(seen)).toEqual(new Set(ids.filter((id) => id !== jumped)));
  });

  it('never makes a row unreachable when two share a millisecond', async () => {
    const owner = await createUser();
    const stamp = new Date(Date.UTC(2026, 0, 3));

    for (let index = 0; index < 4; index += 1) {
      await prisma.note.create({
        data: {
          ownerId: owner.id,
          title: `${TITLE_PREFIX}tie-${index}`,
          sourceType: 'note',
          updatedAt: stamp,
        },
      });
    }

    const seen: string[] = [];
    let cursor: string | null | undefined;

    do {
      const page: Awaited<ReturnType<NotesService['list']>> = await notes.list(
        { limit: 2, cursor: cursor ?? undefined } as never,
        owner.id,
      );

      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);

    // The `id` tie-break is what makes this four rather than two: `updated_at`
    // alone is not unique, and a cursor carrying only a timestamp would either
    // re-serve the whole group or skip the rest of it.
    expect(new Set(seen).size).toBe(4);
  });

  it('restarts from the top for a malformed cursor rather than failing', async () => {
    const owner = await createUser();

    await seed(owner.id, 3);

    const page = await notes.list({ limit: 10, cursor: 'not-a-cursor' } as never, owner.id);

    expect(page.items).toHaveLength(3);
  });

  it('never shows a PREVIEW generation — it has no note, and this list reads notes', async () => {
    const owner = await createUser();

    await seed(owner.id, 2);

    // A real `kind: 'preview'` row, exactly as `POST /api/note-templates/preview`
    // creates one: `note_id: NULL`, an expiry, and no note anywhere.
    const preview = await prisma.noteGeneration.create({
      data: {
        noteId: null,
        kind: 'preview',
        templateNameSnapshot: `${TITLE_PREFIX}preview-template`,
        sourceType: 'note',
        providerId: 'openai',
        model: 'gpt-4o',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const page = await notes.list({ limit: 50 } as never, owner.id);

    expect(page.items).toHaveLength(2);
    expect(page.items.map((item) => item.id)).not.toContain(preview.id);

    await prisma.noteGeneration.delete({ where: { id: preview.id } });
  });

  it('filters to one source transcript, which is what a transcript page asks for (#59)', async () => {
    const owner = await createUser();

    const object = await prisma.storageObject.create({
      data: {
        name: 'audio.m4a',
        size: BigInt(1024),
        mimeType: 'audio/mp4',
        storageKey: `test-paging/${randomUUID()}`,
        managedBy: 'transcripts',
        uploadedById: owner.id,
      },
    });

    const transcript = await prisma.transcript.create({
      data: {
        ownerId: owner.id,
        title: `${TITLE_PREFIX}transcript`,
        sourceObjectId: object.id,
        provider: 'assemblyai',
      },
    });

    await prisma.note.create({
      data: {
        ownerId: owner.id,
        title: `${TITLE_PREFIX}from-transcript`,
        sourceType: 'transcript',
        sourceTranscriptId: transcript.id,
      },
    });

    await seed(owner.id, 2);

    const page = await notes.list(
      { limit: 50, sourceTranscriptId: transcript.id } as never,
      owner.id,
    );

    expect(page.items).toHaveLength(1);
    expect(page.items[0].sourceTranscriptId).toBe(transcript.id);

    await prisma.note.deleteMany({ where: { title: { startsWith: TITLE_PREFIX } } });
    await prisma.transcript.delete({ where: { id: transcript.id } });
    await prisma.storageObject.delete({ where: { id: object.id } });
  });

  it('scopes to the caller: another user\'s notes are not in the list', async () => {
    const owner = await createUser();
    const stranger = await createUser();

    await seed(owner.id, 2);
    await seed(stranger.id, 2);

    const page = await notes.list({ limit: 50 } as never, owner.id);

    expect(page.items).toHaveLength(2);
    expect(page.items.every((item) => item.title.startsWith(TITLE_PREFIX))).toBe(true);
  });
});

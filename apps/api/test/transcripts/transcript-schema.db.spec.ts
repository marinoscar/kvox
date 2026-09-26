// =============================================================================
// Real-Postgres test: the transcript data model's constraints (issue #24,
// epic #19)
// =============================================================================
//
// A foreign key's ON DELETE behaviour and a unique constraint's actual
// enforcement only exist once a migration has run against a real database —
// a unit test importing `schema.prisma` can read the DECLARATION, never
// prove the DATABASE agrees with it. So, like `worker-node-schema.db.spec.ts`
// and `job-node-secret-schema.db.spec.ts` beside it, this is a
// `*.db.spec.ts` file, deliberately excluded from `npm test`/`test:unit`/
// `test:cov`/`test:ci` (see apps/api/package.json's testPathIgnorePatterns).
// It runs only via `npm run test:db`, which CI's `Smoke` job invokes right
// after `prisma:migrate` and before `prisma:seed`. Locally, `npm run
// test:db` needs a real Postgres reachable at POSTGRES_HOST/POSTGRES_PORT
// with the migrations applied; see the reachability check below for what
// happens without one.
//
// What this file asserts, and why each one is the constraint this migration
// is responsible for (docs/specs/transcription.md §3-§6):
//
//   - `(transcript_id, version)` unique on `transcript_versions` — the
//     version sequence `materialize()` (§4.4) walks.
//   - `(transcript_id, client_batch_id)` unique on `transcript_versions`,
//     with NULLs free to repeat — the idempotent-retry key for a batch save
//     (§5), expressible as a plain Prisma `@@unique` because Postgres's
//     standard NULLS-DISTINCT behaviour already gives the wanted semantics.
//   - `(transcript_id, user_id)` unique on `transcript_shares` — one role
//     per (transcript, user) (§6.3).
//   - `(transcript_id, label)` on `transcript_speakers` — the ONE
//     hand-written, Prisma-inexpressible constraint in this migration (a
//     partial unique index, `WHERE label IS NOT NULL`), scoped to labelled
//     rows only so two user-created (label-less) speakers on one transcript
//     never collide (§3.2).
//   - Both `transcripts` indexes: `(owner_id, updated_at DESC)` and
//     `(status)`.
//   - The `users` → `transcripts` CASCADE (deleting an owner deletes their
//     transcripts — no `transcripts:read_any` means an owner-less transcript
//     would be unreachable by anyone, §6.2).
//   - The `storage_objects` → `transcripts.source_object_id` RESTRICT
//     (a storage object a transcript still references may never be deleted
//     out from under it by an unrelated cleanup — only `transcript.purge`,
//     deleting the transcript row first, may ever remove it, §1.5.7/§10).
// =============================================================================

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { buildDatabaseUrl } from '../../src/common/database-url';

const HAND_WRITTEN_INDEX_NAMES = ['transcript_speakers_transcript_id_label_key'];

/**
 * Whether something is actually listening on host:port, checked with a real
 * (short-timeout) TCP connect rather than merely asking whether an env var
 * is set. See `test/jobs/job-schema-indexes.db.spec.ts` for the full
 * rationale behind this exact implementation — copied here verbatim rather
 * than shared, matching that file's own precedent of being self-contained.
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
    `\n[transcript-schema.db.spec] SKIPPED: no Postgres reachable at ` +
      `${postgresHost ?? '(POSTGRES_HOST unset)'}:${postgresPort}. ` +
      `Start infra/compose/test.compose.yml (or otherwise point POSTGRES_HOST/` +
      `POSTGRES_PORT at a migrated database) and re-run \`npm run test:db\` ` +
      `to exercise these real-Postgres assertions.\n`,
  );
}

const describeWithDb = dbReachable ? describe : describe.skip;

describeWithDb('Transcript schema (real Postgres)', () => {
  let prisma: PrismaClient;

  const EMAIL_PREFIX = 'transcript-schema-test';

  beforeAll(async () => {
    // `DATABASE_URL` is stripped before rebuilding from POSTGRES_* for the
    // reason `worker-node-schema.db.spec.ts` records: `test/setup.ts` loads
    // a hard-coded one from `.env.test`, and `buildDatabaseUrl()` lets an
    // already-set value win — which would point this suite somewhere other
    // than the host the reachability check just proved.
    const { DATABASE_URL: _ignored, ...envWithoutDatabaseUrl } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(envWithoutDatabaseUrl)) });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    // Children first, transcripts next, users last — Restrict FKs on the
    // storage objects mean a transcript row must go before its source
    // object can, and every child table cascades off `transcript_id` anyway
    // so most of this is belt-and-braces for rows a failed assertion left
    // behind mid-test.
    await prisma.transcriptExport.deleteMany({
      where: { transcript: { title: { startsWith: 'test-transcript-' } } },
    });
    await prisma.transcriptShare.deleteMany({
      where: { transcript: { title: { startsWith: 'test-transcript-' } } },
    });
    await prisma.transcriptVersion.deleteMany({
      where: { transcript: { title: { startsWith: 'test-transcript-' } } },
    });
    await prisma.transcriptSegment.deleteMany({
      where: { transcript: { title: { startsWith: 'test-transcript-' } } },
    });
    await prisma.transcriptSpeaker.deleteMany({
      where: { transcript: { title: { startsWith: 'test-transcript-' } } },
    });
    await prisma.transcript.deleteMany({ where: { title: { startsWith: 'test-transcript-' } } });
    await prisma.storageObject.deleteMany({
      where: { storageKey: { startsWith: 'test-transcript-schema/' } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  async function createUser(suffix: string) {
    return prisma.user.create({
      data: { email: `${EMAIL_PREFIX}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test` },
    });
  }

  async function createSourceObject(uploadedById: string, suffix: string) {
    return prisma.storageObject.create({
      data: {
        name: 'recording.m4a',
        size: BigInt(1024),
        mimeType: 'audio/mp4',
        storageKey: `test-transcript-schema/${suffix}-${randomUUID()}`,
        managedBy: 'transcripts',
        uploadedById,
      },
    });
  }

  async function createTranscript(ownerId: string, sourceObjectId: string, suffix: string) {
    return prisma.transcript.create({
      data: {
        ownerId,
        title: `test-transcript-${suffix}`,
        sourceObjectId,
        provider: 'assemblyai',
      },
    });
  }

  // ===========================================================================
  // transcript_versions: (transcript_id, version) and
  // (transcript_id, client_batch_id)
  // ===========================================================================

  describe('transcript_versions uniqueness', () => {
    it('rejects a second row with the same (transcriptId, version)', async () => {
      const owner = await createUser('version-owner');
      const source = await createSourceObject(owner.id, 'version');
      const transcript = await createTranscript(owner.id, source.id, 'version');

      await prisma.transcriptVersion.create({
        data: { transcriptId: transcript.id, version: 1, kind: 'ai_original', ops: {} },
      });

      await expect(
        prisma.transcriptVersion.create({
          data: { transcriptId: transcript.id, version: 1, kind: 'edit', ops: {} },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('allows the same version number across two different transcripts', async () => {
      const owner = await createUser('version-cross-owner');
      const sourceA = await createSourceObject(owner.id, 'version-cross-a');
      const sourceB = await createSourceObject(owner.id, 'version-cross-b');
      const transcriptA = await createTranscript(owner.id, sourceA.id, 'version-cross-a');
      const transcriptB = await createTranscript(owner.id, sourceB.id, 'version-cross-b');

      await expect(
        prisma.transcriptVersion.create({
          data: { transcriptId: transcriptA.id, version: 1, kind: 'ai_original', ops: {} },
        }),
      ).resolves.toMatchObject({ version: 1 });
      await expect(
        prisma.transcriptVersion.create({
          data: { transcriptId: transcriptB.id, version: 1, kind: 'ai_original', ops: {} },
        }),
      ).resolves.toMatchObject({ version: 1 });
    });

    it('rejects a second row with the same (transcriptId, clientBatchId)', async () => {
      const owner = await createUser('batch-owner');
      const source = await createSourceObject(owner.id, 'batch');
      const transcript = await createTranscript(owner.id, source.id, 'batch');

      await prisma.transcriptVersion.create({
        data: {
          transcriptId: transcript.id,
          version: 1,
          kind: 'ai_original',
          ops: {},
          clientBatchId: 'batch-1',
        },
      });

      // The retried-save scenario spec §5 describes: a client that saved but
      // never saw the response retries with the identical clientBatchId.
      await expect(
        prisma.transcriptVersion.create({
          data: {
            transcriptId: transcript.id,
            version: 2,
            kind: 'edit',
            ops: {},
            clientBatchId: 'batch-1',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('allows MANY versions with a null clientBatchId on the same transcript (NULLS DISTINCT)', async () => {
      // Ingest and restore never set a clientBatchId — this is the
      // Postgres-native behaviour the schema.prisma comment relies on
      // instead of a hand-written partial index.
      const owner = await createUser('null-batch-owner');
      const source = await createSourceObject(owner.id, 'null-batch');
      const transcript = await createTranscript(owner.id, source.id, 'null-batch');

      await expect(
        prisma.transcriptVersion.create({
          data: { transcriptId: transcript.id, version: 1, kind: 'ai_original', ops: {} },
        }),
      ).resolves.toMatchObject({ clientBatchId: null });
      await expect(
        prisma.transcriptVersion.create({
          data: { transcriptId: transcript.id, version: 2, kind: 'restore', ops: {} },
        }),
      ).resolves.toMatchObject({ clientBatchId: null });
    });
  });

  // ===========================================================================
  // transcript_shares: (transcript_id, user_id)
  // ===========================================================================

  describe('transcript_shares uniqueness', () => {
    it('rejects a second share row for the same (transcriptId, userId)', async () => {
      const owner = await createUser('share-owner');
      const recipient = await createUser('share-recipient');
      const source = await createSourceObject(owner.id, 'share');
      const transcript = await createTranscript(owner.id, source.id, 'share');

      await prisma.transcriptShare.create({
        data: {
          transcriptId: transcript.id,
          userId: recipient.id,
          role: 'viewer',
          grantedById: owner.id,
        },
      });

      await expect(
        prisma.transcriptShare.create({
          data: {
            transcriptId: transcript.id,
            userId: recipient.id,
            role: 'editor',
            grantedById: owner.id,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  // ===========================================================================
  // transcript_speakers: (transcript_id, label) — THE hand-written partial
  // unique index this migration is responsible for
  // ===========================================================================

  describe('transcript_speakers label uniqueness (hand-written partial index)', () => {
    it('creates the partial unique index, not a plain one', async () => {
      const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'transcript_speakers' AND indexname = ANY(${HAND_WRITTEN_INDEX_NAMES})
      `;
      expect(rows.map((r) => r.indexname).sort()).toEqual([...HAND_WRITTEN_INDEX_NAMES].sort());
    });

    it('rejects a second LABELLED speaker with the same label on one transcript', async () => {
      const owner = await createUser('speaker-label-owner');
      const source = await createSourceObject(owner.id, 'speaker-label');
      const transcript = await createTranscript(owner.id, source.id, 'speaker-label');

      await prisma.transcriptSpeaker.create({
        data: { transcriptId: transcript.id, label: 'A', displayName: 'Speaker A', colorIndex: 0 },
      });

      await expect(
        prisma.transcriptSpeaker.create({
          data: {
            transcriptId: transcript.id,
            label: 'A',
            displayName: 'Duplicate A',
            colorIndex: 1,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('allows the SAME label across two different transcripts', async () => {
      const owner = await createUser('speaker-label-cross-owner');
      const sourceA = await createSourceObject(owner.id, 'speaker-label-cross-a');
      const sourceB = await createSourceObject(owner.id, 'speaker-label-cross-b');
      const transcriptA = await createTranscript(owner.id, sourceA.id, 'speaker-label-cross-a');
      const transcriptB = await createTranscript(owner.id, sourceB.id, 'speaker-label-cross-b');

      await expect(
        prisma.transcriptSpeaker.create({
          data: { transcriptId: transcriptA.id, label: 'A', displayName: 'A', colorIndex: 0 },
        }),
      ).resolves.toMatchObject({ label: 'A' });
      await expect(
        prisma.transcriptSpeaker.create({
          data: { transcriptId: transcriptB.id, label: 'A', displayName: 'A', colorIndex: 0 },
        }),
      ).resolves.toMatchObject({ label: 'A' });
    });

    it('allows MANY label-less (user-created) speakers on the SAME transcript', async () => {
      // The whole reason this constraint had to be a PARTIAL index: two
      // speakers created directly by a user (speaker.create, spec §4.1)
      // legitimately have no label at all, and must not collide.
      const owner = await createUser('speaker-no-label-owner');
      const source = await createSourceObject(owner.id, 'speaker-no-label');
      const transcript = await createTranscript(owner.id, source.id, 'speaker-no-label');

      await expect(
        prisma.transcriptSpeaker.create({
          data: { transcriptId: transcript.id, displayName: 'Guest 1', colorIndex: 0 },
        }),
      ).resolves.toMatchObject({ label: null });
      await expect(
        prisma.transcriptSpeaker.create({
          data: { transcriptId: transcript.id, displayName: 'Guest 2', colorIndex: 1 },
        }),
      ).resolves.toMatchObject({ label: null });
    });
  });

  // ===========================================================================
  // transcripts: the two @@index entries
  // ===========================================================================

  describe('transcripts indexes', () => {
    it('has the (owner_id, updated_at DESC) and (status) indexes', async () => {
      const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname FROM pg_indexes WHERE tablename = 'transcripts'
      `;
      const names = rows.map((r) => r.indexname);
      expect(names).toContain('transcripts_owner_id_updated_at_idx');
      expect(names).toContain('transcripts_status_idx');
    });

    it('has the (owner_id, recorded_at DESC) index (#352)', async () => {
      const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'transcripts' AND indexname = 'transcripts_owner_id_recorded_at_idx'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toMatch(/\(owner_id, recorded_at DESC\)/);
    });
  });

  // ===========================================================================
  // recorded_at (issue #352)
  // ===========================================================================

  describe('transcripts.recorded_at (#352)', () => {
    it('is a NOT NULL timestamptz with a default', async () => {
      const rows = await prisma.$queryRaw<
        Array<{ is_nullable: string; data_type: string; column_default: string | null }>
      >`
        SELECT is_nullable, data_type, column_default FROM information_schema.columns
        WHERE table_name = 'transcripts' AND column_name = 'recorded_at'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].is_nullable).toBe('NO');
      expect(rows[0].data_type).toBe('timestamp with time zone');
      expect(rows[0].column_default).toMatch(/CURRENT_TIMESTAMP|now\(\)/i);
    });

    it('defaults a row created without it, and round-trips an explicit value', async () => {
      const owner = await createUser('recorded-at');
      const source = await createSourceObject(owner.id, 'recorded-at');
      const transcript = await createTranscript(owner.id, source.id, 'recorded-at');

      expect(transcript.recordedAt).toBeInstanceOf(Date);

      const updated = await prisma.transcript.update({
        where: { id: transcript.id },
        data: { recordedAt: new Date('2026-03-02T20:00:00.000Z') },
      });
      expect(updated.recordedAt.toISOString()).toBe('2026-03-02T20:00:00.000Z');
    });
  });

  // ===========================================================================
  // owner_id CASCADE
  // ===========================================================================

  describe('owner deletion cascades the transcript (no read-any, spec §6.2)', () => {
    it('deletes the transcript row when its owner is deleted', async () => {
      const owner = await createUser('cascade-owner');
      const source = await createSourceObject(owner.id, 'cascade');
      const transcript = await createTranscript(owner.id, source.id, 'cascade');

      await prisma.user.delete({ where: { id: owner.id } });

      await expect(
        prisma.transcript.findUnique({ where: { id: transcript.id } }),
      ).resolves.toBeNull();

      // The storage object itself is untouched by the cascade — Restrict on
      // `source_object_id` means Postgres never even attempts to touch it
      // when the REFERENCING transcripts row disappears. Cleaned up
      // directly here since the transcript that would normally gate its
      // deletion is already gone.
      await prisma.storageObject.delete({ where: { id: source.id } });
    });
  });

  // ===========================================================================
  // source_object_id RESTRICT
  // ===========================================================================

  describe('a transcript RESTRICTS deletion of its source storage object', () => {
    it('refuses to delete the storage_objects row a transcript still references', async () => {
      const owner = await createUser('restrict-owner');
      const source = await createSourceObject(owner.id, 'restrict');
      await createTranscript(owner.id, source.id, 'restrict');

      await expect(prisma.storageObject.delete({ where: { id: source.id } })).rejects.toMatchObject(
        { code: 'P2003' },
      );
    });

    it('allows deleting the storage object once the referencing transcript is gone', async () => {
      const owner = await createUser('restrict-release-owner');
      const source = await createSourceObject(owner.id, 'restrict-release');
      const transcript = await createTranscript(owner.id, source.id, 'restrict-release');

      await prisma.transcript.delete({ where: { id: transcript.id } });

      await expect(prisma.storageObject.delete({ where: { id: source.id } })).resolves.toMatchObject(
        { id: source.id },
      );
    });
  });

  // ===========================================================================
  // speaker_id RESTRICT on transcript_segments
  // ===========================================================================

  describe('a segment RESTRICTS deletion of its speaker', () => {
    it('refuses to delete a speaker while a segment still names it', async () => {
      const owner = await createUser('speaker-restrict-owner');
      const source = await createSourceObject(owner.id, 'speaker-restrict');
      const transcript = await createTranscript(owner.id, source.id, 'speaker-restrict');
      const speaker = await prisma.transcriptSpeaker.create({
        data: { transcriptId: transcript.id, label: 'A', displayName: 'A', colorIndex: 0 },
      });
      await prisma.transcriptSegment.create({
        data: {
          transcriptId: transcript.id,
          speakerId: speaker.id,
          startMs: 0,
          endMs: 1000,
          ordinal: 1000,
          text: 'Hello world',
          words: [],
        },
      });

      await expect(
        prisma.transcriptSpeaker.delete({ where: { id: speaker.id } }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });
  });
});

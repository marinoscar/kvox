// =============================================================================
// Real-Postgres test: kg:eval --export-note (issue #362)
// =============================================================================
//
// The skeleton export reads a real note, its origin transcript's segments and
// speaker identities through Prisma, and writes an UNLABELLED fixture outside
// the repository. Proven against a migrated database because the reads it
// makes (ordinal ordering, the identities JSON, the origin-transcript walk)
// are only real there. Ownership mirrors the API: another user's note is
// "not found", never a distinguishable refusal.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { goldenFixtureSchema } from '../../scripts/kg-eval/fixture-schema';
import { exportNoteSkeleton, RealDataNotFoundError, RealDataPathError } from '../../scripts/kg-eval/real-data';
import { buildDatabaseUrl } from '../../src/common/database-url';
import { resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb, dbReachable } = resolveDbSuite('kg-eval-export.db.spec');

const EMAIL_PREFIX = 'kg-eval-export-test';

describeWithDb('kg:eval --export-note (real Postgres)', () => {
  let prisma: PrismaClient;
  let realDir: string;

  beforeAll(async () => {
    if (!dbReachable) return;
    const { DATABASE_URL: _ignored, ...env } = process.env;
    prisma = new PrismaClient({ adapter: new PrismaPg(buildDatabaseUrl(env)) });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    realDir = mkdtempSync(join(tmpdir(), 'kg-eval-real-'));
  });

  afterEach(async () => {
    rmSync(realDir, { recursive: true, force: true });
    if (!dbReachable) return;
    const owner = { owner: { email: { startsWith: EMAIL_PREFIX } } };
    await prisma.noteVersion.deleteMany({ where: { note: owner } });
    await prisma.note.deleteMany({ where: owner });
    await prisma.transcriptSegment.deleteMany({ where: { transcript: owner } });
    await prisma.transcriptSpeaker.deleteMany({ where: { transcript: owner } });
    await prisma.transcript.deleteMany({ where: owner });
    await prisma.storageObject.deleteMany({ where: { uploadedBy: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  });

  async function user(suffix: string) {
    return prisma.user.create({
      data: { email: `${EMAIL_PREFIX}-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test` },
    });
  }

  async function seed(ownerId: string) {
    const source = await prisma.storageObject.create({
      data: {
        name: 'call.m4a',
        size: BigInt(1),
        mimeType: 'audio/mp4',
        storageKey: `${EMAIL_PREFIX}/${randomUUID()}`,
        managedBy: 'transcripts',
        uploadedById: ownerId,
      },
    });
    const transcript = await prisma.transcript.create({
      data: {
        ownerId,
        title: 'Planning call',
        sourceObjectId: source.id,
        provider: 'assemblyai',
        recordedAt: new Date('2026-03-05T10:00:00Z'),
      },
    });
    const a = await prisma.transcriptSpeaker.create({
      data: { transcriptId: transcript.id, label: 'A', displayName: 'Speaker A', colorIndex: 0 },
    });
    const b = await prisma.transcriptSpeaker.create({
      data: { transcriptId: transcript.id, label: 'B', displayName: 'Speaker B', colorIndex: 1 },
    });
    await prisma.transcript.update({
      where: { id: transcript.id },
      data: { speakerIdentities: { [a.id]: 'Dana Ortiz' } },
    });
    // Inserted out of order: the export must follow `ordinal`, not insertion.
    await prisma.transcriptSegment.create({
      data: { transcriptId: transcript.id, speakerId: b.id, startMs: 1500, endMs: 2500, ordinal: 2000, text: 'Second line.', words: [] },
    });
    await prisma.transcriptSegment.create({
      data: { transcriptId: transcript.id, speakerId: a.id, startMs: 0, endMs: 1000, ordinal: 1000, text: 'First line.', words: [] },
    });
    const note = await prisma.note.create({
      data: {
        ownerId,
        title: 'Planning call notes',
        body: 'live body',
        status: 'ready',
        currentVersion: 2,
        sourceType: 'transcript',
        sourceTranscriptId: transcript.id,
        contextText: 'Quarterly planning',
      },
    });
    await prisma.noteVersion.createMany({
      data: [
        { noteId: note.id, version: 1, kind: 'ai_generated', body: 'first version' },
        { noteId: note.id, version: 2, kind: 'edit', body: '# Planning call notes\n\nEdited body.' },
      ],
    });
    return { note, transcript, a, b };
  }

  it('writes an unlabelled skeleton that parses as a golden fixture', async () => {
    const owner = await user('owner');
    const { note, a } = await seed(owner.id);

    const file = await exportNoteSkeleton({ prisma, noteId: note.id, email: owner.email, realDir });
    const fixture = goldenFixtureSchema.parse(JSON.parse(readFileSync(file, 'utf8')));

    expect(fixture.id).toBe('m901');
    expect(fixture.title).toBe('Planning call notes');
    expect(fixture.recordedAt).toBe('2026-03-05T10:00:00.000Z');
    expect(fixture.contextText).toBe('Quarterly planning');
    expect(fixture.hasTranscript).toBe(true);
    expect(fixture.note).toEqual({ version: 2, body: '# Planning call notes\n\nEdited body.' });
    expect(fixture.segments.map((s) => s.text)).toEqual(['First line.', 'Second line.']);
    expect(fixture.speakers.find((s) => s.id === a.id)?.displayName).toBe('Dana Ortiz');
    expect(fixture.labels).toEqual({ entities: [], relations: [], items: [], negatives: [] });

    // A second export takes the next free id.
    const second = await exportNoteSkeleton({ prisma, noteId: note.id, email: owner.email, realDir });
    expect(JSON.parse(readFileSync(second, 'utf8')).id).toBe('m902');
  });

  it("answers another user's note with a plain not found", async () => {
    const owner = await user('owner');
    const stranger = await user('stranger');
    const { note } = await seed(owner.id);
    await expect(
      exportNoteSkeleton({ prisma, noteId: note.id, email: stranger.email, realDir }),
    ).rejects.toThrow(RealDataNotFoundError);
    await expect(
      exportNoteSkeleton({ prisma, noteId: note.id, email: `${EMAIL_PREFIX}-nobody@example.test`, realDir }),
    ).rejects.toThrow('not found');
  });

  it('refuses a real directory inside the repository before reading anything', async () => {
    await expect(
      exportNoteSkeleton({ prisma, noteId: randomUUID(), email: 'x@example.test', realDir: __dirname }),
    ).rejects.toThrow(RealDataPathError);
  });
});

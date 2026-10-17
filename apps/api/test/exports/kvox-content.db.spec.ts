// =============================================================================
// Real-Postgres test: the `kvox-content` export source (issue #532, Part B of #479)
// =============================================================================
//
// The source's whole job is to filter by ownership of the PARENT row, so the case that
// matters is the one the platform's actor filter gets wrong:
//
//   * user A owns transcript TA (one speaker, two segments, one of them last edited by B)
//     and note NA (a version authored by B);
//   * user B owns transcript TB, shared to A, and A edited one of its segments; B also
//     owns note NB, a version of which A authored, and an Ask conversation.
//
// Exporting for A must return TA's speaker and BOTH of TA's segments (the one B edited
// included), NA's version, and nothing that belongs to B: not TB's segment A corrected, not
// NB's version A wrote, not B's Ask messages. A sensitive attribute definition is left out.
//
// Read through an ordinary client (the suite's connection is a superuser, to which row-level
// security does not apply); the source's own `where` is what is under test. Excluded from
// `npm test`; run by `npm run test:db`. UNRUN in the session that wrote it (no Docker).
// =============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import type { ExportContext, ExportTable } from '@marinoscar/platform-api/exports';

import '../../src/kvox.manifest';
import '../../src/app-registrations/registrations';

import { kvoxContentTables } from '../../src/platform/exports/kvox-content.source';
import { cleanupGraphFixtures, connectTestPrisma, createUser } from '../graph/graph-read.fixtures';
import { resolveDbSuite } from '../jobs/db-test-support';
import { createStorageObject } from '../helpers/storage-object.helper';
import { createTranscript } from '../helpers/transcript.helper';

const { describeWithDb, dbReachable } = resolveDbSuite('kvox-content.db.spec');

const EMAIL_PREFIX = 'kvox-content-export-test';

describeWithDb('the kvox-content export source (real Postgres)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = connectTestPrisma();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    await prisma.askMessage.deleteMany({ where: { conversation: { owner: { email: { startsWith: EMAIL_PREFIX } } } } });
    await prisma.askConversation.deleteMany({ where: { owner: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.kgAttributeDef.deleteMany({ where: { owner: { email: { startsWith: EMAIL_PREFIX } } } });
    await cleanupGraphFixtures(prisma, EMAIL_PREFIX);
  }, 120_000);

  async function transcriptOf(ownerId: string, title: string) {
    const source = await createStorageObject(prisma, {
      data: { name: title, size: BigInt(1), mimeType: 'audio/mp4', storageKey: `${EMAIL_PREFIX}/${title}-${randomUUID()}`, uploadedById: ownerId },
    });
    const transcript = await createTranscript(prisma, {
      data: { ownerId, title, sourceObjectId: source.id, provider: 'assemblyai' },
    });
    const speaker = await prisma.transcriptSpeaker.create({
      data: { transcriptId: transcript.id, label: 'A', displayName: `${title} speaker`, colorIndex: 0 },
    });
    const segment = (text: string, ordinal: number, editedById: string | null) =>
      prisma.transcriptSegment.create({
        data: { transcriptId: transcript.id, speakerId: speaker.id, startMs: ordinal * 1000, endMs: ordinal * 1000 + 900, ordinal, text, words: [], editedById },
      });

    return { transcript, speaker, segment };
  }

  async function noteOf(ownerId: string, title: string, authorId: string) {
    const note = await prisma.note.create({ data: { ownerId, title, body: `${title} body`, sourceType: 'document' } });
    await prisma.noteVersion.create({ data: { noteId: note.id, version: 1, kind: 'edit', body: `${title} v1`, authorId } });

    return note;
  }

  async function exportFor(userId: string): Promise<Record<string, Array<Record<string, unknown>>>> {
    const ctx: ExportContext = {
      exportId: randomUUID(),
      scope: 'user',
      subjectId: userId,
      requestedById: userId,
      db: prisma as never,
      datamodel: Prisma.dmmf.datamodel,
      pageSize: 1, // forces several pages: the owner filter must survive the cursor
      now: new Date(),
    };
    const out: Record<string, Array<Record<string, unknown>>> = {};

    for await (const table of kvoxContentTables(ctx) as AsyncIterable<ExportTable>) {
      out[table.dataset] = [];
      for await (const row of table.rows) out[table.dataset].push(row as Record<string, unknown>);
    }

    return out;
  }

  it('returns the owner’s speakers, segments, note versions and Ask messages, and nothing of another user’s', async () => {
    const a = await createUser(prisma, EMAIL_PREFIX, 'a');
    const b = await createUser(prisma, EMAIL_PREFIX, 'b');

    const ta = await transcriptOf(a.id, 'TA');
    await ta.segment('A wrote this', 0, null);
    await ta.segment('B corrected this in A’s transcript', 1, b.id);

    const tb = await transcriptOf(b.id, 'TB');
    await tb.segment('A corrected this in B’s transcript', 0, a.id);
    await tb.segment('B only', 1, null);

    const na = await noteOf(a.id, 'NA', b.id);
    await noteOf(b.id, 'NB', a.id);

    const convA = await prisma.askConversation.create({ data: { ownerId: a.id, title: 'mine' } });
    const convB = await prisma.askConversation.create({ data: { ownerId: b.id, title: 'theirs' } });
    await prisma.askMessage.create({ data: { conversationId: convA.id, role: 'user', content: 'A asks', status: 'complete' } });
    await prisma.askMessage.create({ data: { conversationId: convB.id, role: 'user', content: 'B asks', status: 'complete' } });

    await prisma.kgAttributeDef.create({ data: { ownerId: a.id, entityType: 'Person', key: 'nickname', label: 'Nickname', kind: 'text' } });
    await prisma.kgAttributeDef.create({
      data: { ownerId: a.id, entityType: 'Person', key: 'diagnosis', label: 'Diagnosis', kind: 'text', sensitivity: 'sensitive' },
    });
    await prisma.kgAttributeDef.create({ data: { ownerId: b.id, entityType: 'Person', key: 'other', label: 'Other', kind: 'text' } });

    const out = await exportFor(a.id);

    expect(out.transcript_speaker.map((row) => row.displayName)).toEqual(['TA speaker']);
    expect(out.transcript_segment.map((row) => row.text).sort()).toEqual(['A wrote this', 'B corrected this in A’s transcript']);
    expect(out.note_version.map((row) => row.noteId)).toEqual([na.id]);
    expect(out.note_version.map((row) => row.body)).toEqual(['NA v1']);
    expect(out.ask_message.map((row) => row.content)).toEqual(['A asks']);
    expect(out.kg_attribute_def.map((row) => row.key)).toEqual(['nickname']);

    // Left out columns are not selected at all.
    expect(out.transcript_segment[0]).not.toHaveProperty('words');
    expect(out.ask_message[0]).not.toHaveProperty('toolCalls');

    const outB = await exportFor(b.id);

    expect(outB.transcript_segment.map((row) => row.text).sort()).toEqual(['A corrected this in B’s transcript', 'B only']);
    expect(outB.ask_message.map((row) => row.content)).toEqual(['B asks']);
  }, 120_000);
});

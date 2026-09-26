import { NotFoundException } from '@nestjs/common';
import type { KgEvidence } from '@prisma/client';

import { GraphEvidenceService, evidenceSourceKind, noteHref, segmentHref } from './graph-evidence.service';

// =============================================================================
// GraphEvidenceService (#370): href building and the available / textChanged /
// versionChanged derivation, over a mocked Prisma and mocked access services.
// =============================================================================

const USER = '00000000-0000-4000-8000-0000000000aa';
const T1 = '00000000-0000-4000-8000-000000000001';
const T2 = '00000000-0000-4000-8000-000000000002';
const SEG = '00000000-0000-4000-8000-000000000005';
const NOTE = '00000000-0000-4000-8000-000000000006';
const OBJ = '00000000-0000-4000-8000-000000000007';
const SUBJ = '00000000-0000-4000-8000-000000000009';
const CREATED = new Date('2026-09-01T00:00:00.000Z');

function ev(over: Partial<KgEvidence>): KgEvidence {
  return {
    id: '00000000-0000-4000-8000-0000000000e1',
    ownerId: USER,
    subjectKind: 'entity',
    subjectId: SUBJ,
    transcriptId: null,
    segmentId: null,
    segmentRev: null,
    startMs: null,
    endMs: null,
    noteId: null,
    noteVersion: null,
    charStart: null,
    charEnd: null,
    quote: 'the quote',
    importObjectId: null,
    sourceIri: null,
    createdAt: CREATED,
    ...over,
  } as KgEvidence;
}

function build(state: {
  transcripts?: { id: string; ownerId: string; title: string; deletedAt: Date | null }[];
  segments?: { id: string; transcriptId: string; rev: number }[];
  notes?: { id: string; ownerId: string; title: string; deletedAt: Date | null; currentVersion: number }[];
  objects?: { id: string; uploadedById: string }[];
  evidence?: KgEvidence[];
  sharedWith?: string[];
}) {
  const prisma = {
    transcript: { findMany: jest.fn(async () => state.transcripts ?? []) },
    transcriptSegment: { findMany: jest.fn(async () => state.segments ?? []) },
    note: { findMany: jest.fn(async () => state.notes ?? []) },
    storageObject: { findMany: jest.fn(async () => state.objects ?? []) },
    kgEvidence: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] }; ownerId: string } }) =>
        (state.evidence ?? []).filter((e) => where.id.in.includes(e.id) && e.ownerId === where.ownerId),
      ),
    },
  };
  const access = {
    require: jest.fn(async (userId: string, _kind: string, id: string) => {
      const row = (state.evidence ?? []).find((e) => e.id === id && e.ownerId === userId);
      if (!row) throw new NotFoundException('Evidence not found');
      return row;
    }),
  };
  const transcriptAccess = {
    roleFor: jest.fn(async (userId: string, t: { id: string; ownerId: string }) =>
      t.ownerId === userId ? 'owner' : (state.sharedWith ?? []).includes(t.id) ? 'viewer' : null,
    ),
  };
  const noteAccess = { roleFor: jest.fn((userId: string, n: { ownerId: string }) => (n.ownerId === userId ? 'owner' : null)) };
  const svc = new GraphEvidenceService(prisma as never, access as never, transcriptAccess as never, noteAccess as never);
  return { svc, prisma, access, transcriptAccess };
}

describe('href builders', () => {
  it('build a playable segment deep link and a note-version link', () => {
    expect(segmentHref(T1, SEG, 1500)).toBe(`/transcripts/${T1}?segment=${SEG}&t=1500`);
    expect(segmentHref(T1, null, null)).toBe(`/transcripts/${T1}`);
    expect(segmentHref(T1, SEG, 0)).toBe(`/transcripts/${T1}?segment=${SEG}&t=0`);
    expect(noteHref(NOTE, 3)).toBe(`/notes/${NOTE}?v=3`);
  });

  it('classify the anchor, surviving SetNull through note_version', () => {
    expect(evidenceSourceKind(ev({ transcriptId: T1, segmentId: SEG }))).toBe('segment');
    expect(evidenceSourceKind(ev({ noteId: null, noteVersion: 2 }))).toBe('note');
    expect(evidenceSourceKind(ev({ importObjectId: OBJ }))).toBe('import');
    expect(evidenceSourceKind(ev({ subjectKind: 'import' }))).toBe('import');
    expect(evidenceSourceKind(ev({}))).toBe('segment');
  });
});

describe('GraphEvidenceService.resolve', () => {
  it('links an owned transcript segment and reports an edited segment', async () => {
    const { svc } = build({
      transcripts: [{ id: T1, ownerId: USER, title: 'Standup', deletedAt: null }],
      segments: [{ id: SEG, transcriptId: T1, rev: 3 }],
    });
    const [link] = await svc.resolve(USER, [ev({ transcriptId: T1, segmentId: SEG, segmentRev: 2, startMs: 1500, endMs: 3000 })]);
    expect(link).toEqual({
      id: expect.any(String),
      subjectKind: 'entity',
      subjectId: SUBJ,
      quote: 'the quote',
      createdAt: CREATED.toISOString(),
      source: {
        kind: 'segment',
        transcriptId: T1,
        transcriptTitle: 'Standup',
        segmentId: SEG,
        segmentRev: 2,
        currentSegmentRev: 3,
        startMs: 1500,
        endMs: 3000,
        textChanged: true,
        available: true,
        href: `/transcripts/${T1}?segment=${SEG}&t=1500`,
      },
    });
  });

  it('keeps the quote but drops title, revision and link once a share is revoked or the transcript deleted', async () => {
    const { svc } = build({
      transcripts: [
        { id: T1, ownerId: 'someone-else', title: 'Their call', deletedAt: null },
        { id: T2, ownerId: USER, title: 'Deleted', deletedAt: new Date() },
      ],
      segments: [{ id: SEG, transcriptId: T1, rev: 9 }],
      sharedWith: [], // revoked
    });
    const [revoked, deleted, nulled] = await svc.resolve(USER, [
      ev({ transcriptId: T1, segmentId: SEG, segmentRev: 1 }),
      ev({ transcriptId: T2 }),
      ev({ transcriptId: null, segmentId: null, segmentRev: 4, quote: 'survives' }),
    ]);
    for (const link of [revoked, deleted, nulled]) {
      expect(link.source).toMatchObject({ kind: 'segment', available: false, href: null, transcriptTitle: null, textChanged: false });
    }
    expect(revoked.source).toMatchObject({ currentSegmentRev: null });
    expect(nulled.quote).toBe('survives');
  });

  it('honours a live share', async () => {
    const { svc } = build({
      transcripts: [{ id: T1, ownerId: 'someone-else', title: 'Their call', deletedAt: null }],
      segments: [{ id: SEG, transcriptId: T1, rev: 1 }],
      sharedWith: [T1],
    });
    const [link] = await svc.resolve(USER, [ev({ transcriptId: T1, segmentId: SEG, segmentRev: 1 })]);
    expect(link.source).toMatchObject({ available: true, textChanged: false, transcriptTitle: 'Their call' });
  });

  it('ignores a segment that belongs to a different transcript', async () => {
    const { svc } = build({
      transcripts: [{ id: T1, ownerId: USER, title: 'Standup', deletedAt: null }],
      segments: [{ id: SEG, transcriptId: T2, rev: 1 }],
    });
    const [link] = await svc.resolve(USER, [ev({ transcriptId: T1, segmentId: SEG, segmentRev: 1 })]);
    expect(link.source).toMatchObject({ currentSegmentRev: null, textChanged: true, available: true });
  });

  it('links a note version and flags a newer current version', async () => {
    const { svc } = build({ notes: [{ id: NOTE, ownerId: USER, title: 'Prep', deletedAt: null, currentVersion: 4 }] });
    const [changed, same] = await svc.resolve(USER, [
      ev({ noteId: NOTE, noteVersion: 2, charStart: 0, charEnd: 10 }),
      ev({ noteId: NOTE, noteVersion: 4 }),
    ]);
    expect(changed.source).toEqual({
      kind: 'note',
      noteId: NOTE,
      noteTitle: 'Prep',
      noteVersion: 2,
      currentNoteVersion: 4,
      charStart: 0,
      charEnd: 10,
      versionChanged: true,
      available: true,
      href: `/notes/${NOTE}?v=2`,
    });
    expect(same.source).toMatchObject({ versionChanged: false });
  });

  it('marks a deleted or foreign note unavailable', async () => {
    const { svc } = build({
      notes: [
        { id: NOTE, ownerId: USER, title: 'Gone', deletedAt: new Date(), currentVersion: 1 },
        { id: SUBJ, ownerId: 'someone-else', title: 'Theirs', deletedAt: null, currentVersion: 1 },
      ],
    });
    const links = await svc.resolve(USER, [ev({ noteId: NOTE, noteVersion: 1 }), ev({ noteId: SUBJ, noteVersion: 1 })]);
    for (const link of links) {
      expect(link.source).toMatchObject({ available: false, href: null, noteTitle: null, currentNoteVersion: null, versionChanged: false });
    }
  });

  it('resolves import evidence with no link', async () => {
    const { svc } = build({ objects: [{ id: OBJ, uploadedById: USER }] });
    const [mine, missing] = await svc.resolve(USER, [
      ev({ importObjectId: OBJ, sourceIri: 'urn:x' }),
      ev({ importObjectId: null, sourceIri: 'urn:y' }),
    ]);
    expect(mine.source).toEqual({ kind: 'import', importObjectId: OBJ, sourceIri: 'urn:x', available: true, href: null });
    expect(missing.source).toMatchObject({ available: false, href: null });
  });

  it('issues no source query for a table the batch does not cite', async () => {
    const { svc, prisma } = build({});
    await svc.resolve(USER, [ev({ noteId: NOTE, noteVersion: 1 })]);
    expect(prisma.transcript.findMany).not.toHaveBeenCalled();
    expect(prisma.transcriptSegment.findMany).not.toHaveBeenCalled();
    expect(prisma.storageObject.findMany).not.toHaveBeenCalled();
    expect(prisma.note.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('GraphEvidenceService.getOne / getMany', () => {
  const mine = ev({ id: '00000000-0000-4000-8000-0000000000e1' });
  const theirs = ev({ id: '00000000-0000-4000-8000-0000000000e2', ownerId: 'someone-else' });
  const second = ev({ id: '00000000-0000-4000-8000-0000000000e3' });

  it('authorises a single id through GraphAccessService (404 for not-yours)', async () => {
    const { svc, access } = build({ evidence: [mine, theirs] });
    await expect(svc.getOne(USER, mine.id)).resolves.toMatchObject({ id: mine.id });
    expect(access.require).toHaveBeenCalledWith(USER, 'evidence', mine.id, 'view');
    await expect(svc.getOne(USER, theirs.id)).rejects.toThrow(NotFoundException);
  });

  it('returns a batch in request order, silently omitting unknown and foreign ids', async () => {
    const { svc } = build({ evidence: [mine, theirs, second] });
    const links = await svc.getMany(USER, [second.id, theirs.id, '00000000-0000-4000-8000-0000000000ff', mine.id, second.id]);
    expect(links.map((l) => l.id)).toEqual([second.id, mine.id]);
    await expect(svc.getMany(USER, [])).resolves.toEqual([]);
  });
});

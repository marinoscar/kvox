// =============================================================================
// SpeakerLinkReconciler — the reconcile's branches, on a mocked transaction
// (#356). The real-Postgres end to end (the advisory lock, the unique index,
// the deferred trigger, cascades) is `test/graph/kg-speaker-link.db.spec.ts`.
// =============================================================================

import {
  SPEAKER_LINKED_ACTION,
  SPEAKER_UNLINKED_ACTION,
  SpeakerLinkReconciler,
  effectiveSpeakerNames,
  pickPerson,
  safeNormalize,
  type PersonCandidate,
} from './speaker-link.reconciler';

const TRANSCRIPT = 't-1';
const OWNER = 'owner-1';
const SPEAKER_A = 'spk-a';
const SPEAKER_B = 'spk-b';
const SCHEMA = { marker: 'schema' };

type Mock = jest.Mock;

function segment(id: string, text = `said ${id}`) {
  return { id, rev: 2, startMs: 100, endMs: 900, text };
}

function setup(opts: {
  transcript?: { ownerId: string; speakerIdentities: unknown; deletedAt: Date | null } | null;
  canWrite?: boolean;
  speakers?: string[];
  /** Live `transcript_speakers` names (#405); default: each speaker still on its placeholder. */
  liveNames?: Record<string, string>;
  edges?: Array<{ id: string; speakerId: string; personId: string; label: string; aliases?: string[]; status?: string }>;
  persons?: Array<{ id: string; label: string; aliases?: string[]; identified?: number; updatedAt?: Date }>;
  segments?: Record<string, ReturnType<typeof segment>[]>;
  counts?: Partial<Record<string, number>>;
} = {}) {
  const counts = opts.counts ?? {};
  const count = (key: string) => jest.fn().mockResolvedValue(counts[key] ?? 0);

  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    transcript: {
      findUnique: jest.fn().mockResolvedValue(
        opts.transcript === undefined
          ? { ownerId: OWNER, speakerIdentities: { [SPEAKER_A]: 'Sarah Chen' }, deletedAt: null }
          : opts.transcript,
      ),
    },
    user: { findFirst: jest.fn().mockResolvedValue(opts.canWrite === false ? null : { id: OWNER }) },
    transcriptSpeaker: {
      findMany: jest.fn().mockResolvedValue(
        (opts.speakers ?? [SPEAKER_A, SPEAKER_B]).map((id) => ({
          id,
          label: id,
          displayName: opts.liveNames?.[id] ?? `Speaker ${id}`,
        })),
      ),
    },
    transcriptSegment: {
      findMany: jest.fn().mockImplementation(async ({ where }: { where: { speakerId: string } }) =>
        (opts.segments ?? {})[where.speakerId] ?? [segment(`${where.speakerId}-s1`), segment(`${where.speakerId}-s2`)],
      ),
    },
    kgRelation: {
      findMany: jest.fn().mockResolvedValue(
        (opts.edges ?? []).map((e) => ({
          id: e.id,
          fromSpeakerId: e.speakerId,
          toId: e.personId,
          toEntity: {
            label: e.label,
            reviewStatus: e.status ?? 'accepted',
            aliases: [e.label, ...(e.aliases ?? [])].map((alias) => ({ alias })),
          },
        })),
      ),
      delete: jest.fn().mockResolvedValue({}),
      count: count('relations'),
    },
    kgEntity: {
      findMany: jest.fn().mockResolvedValue(
        (opts.persons ?? []).map((p) => ({
          id: p.id,
          label: p.label,
          updatedAt: p.updatedAt ?? new Date('2026-01-01'),
          aliases: [p.label, ...(p.aliases ?? [])].map((alias) => ({ alias, normalized: safeNormalize(alias) })),
          _count: { relationsTo: p.identified ?? 0 },
        })),
      ),
      findFirst: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id })),
      count: count('mergedFrom'),
      delete: jest.fn().mockResolvedValue({}),
    },
    kgEntityAlias: { count: count('otherAliases'), deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    kgItem: { count: count('items') },
    kgMention: { count: count('mentions') },
    kgMerge: { count: count('merges') },
    kgEntityDigest: { count: count('digests') },
    kgEvidence: { count: count('foreignEvidence'), deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };

  let created = 0;
  const write = {
    createEntity: jest.fn().mockImplementation(async () => ({ id: `new-person-${++created}` })),
    createRelation: jest.fn().mockResolvedValue({ id: 'new-edge' }),
    addAliases: jest.fn().mockResolvedValue([]),
  };
  const ontology = { effectiveSchemaFor: jest.fn().mockResolvedValue(SCHEMA) };
  const reconciler = new SpeakerLinkReconciler(write as never, ontology as never);
  const run = (actorUserId = OWNER) => reconciler.reconcile(tx as never, { transcriptId: TRANSCRIPT, actorUserId });
  const audits = () => (tx.auditEvent.create as Mock).mock.calls.map((c) => c[0].data);

  return { tx, write, ontology, run, audits };
}

const noWrites = (s: ReturnType<typeof setup>) => {
  expect(s.write.createEntity).not.toHaveBeenCalled();
  expect(s.write.createRelation).not.toHaveBeenCalled();
  expect(s.tx.kgRelation.delete).not.toHaveBeenCalled();
  expect(s.tx.auditEvent.create).not.toHaveBeenCalled();
};

describe('SpeakerLinkReconciler', () => {
  describe('writes nothing by design', () => {
    it('for a missing transcript', async () => {
      const s = setup({ transcript: null });
      await expect(s.run()).resolves.toMatchObject({ skipped: 'missing' });
      noWrites(s);
    });

    it('for a soft-deleted transcript', async () => {
      const s = setup({ transcript: { ownerId: OWNER, speakerIdentities: { [SPEAKER_A]: 'X' }, deletedAt: new Date() } });
      await expect(s.run()).resolves.toMatchObject({ skipped: 'missing' });
      noWrites(s);
    });

    it('when the actor is not the owner (§12) — and never asks about permissions', async () => {
      const s = setup();
      await expect(s.run('editor-1')).resolves.toMatchObject({ skipped: 'not_owner' });
      expect(s.tx.user.findFirst).not.toHaveBeenCalled();
      noWrites(s);
    });

    it('when the owner lacks graph:write', async () => {
      const s = setup({ canWrite: false });
      await expect(s.run()).resolves.toMatchObject({ skipped: 'no_permission' });
      expect(s.tx.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: OWNER,
            isActive: true,
            userRoles: { some: { role: { rolePermissions: { some: { permission: { name: 'graph:write' } } } } } },
          }),
        }),
      );
      noWrites(s);
    });

    it('takes the per-transcript advisory lock first', async () => {
      const s = setup();
      await s.run();
      const lockOrder = s.tx.$executeRaw.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(s.tx.transcript.findUnique.mock.invocationCallOrder[0]);
      expect(s.tx.$executeRaw.mock.calls[0].slice(1)).toEqual([`kg.speaker_link:${TRANSCRIPT}`]);
    });
  });

  describe('a named speaker', () => {
    it('creates an accepted Person, labelled with the name, cited by ≤ 3 of its segments', async () => {
      const segments = [segment('s1'), segment('s2', '   '), segment('s3'), segment('s4', 'x'.repeat(900)), segment('s5')];
      const s = setup({ segments: { [SPEAKER_A]: segments } });

      const summary = await s.run();

      expect(summary).toMatchObject({ skipped: null, linked: 1, created: 1, unlinked: 0, createdPersonIds: ['new-person-1'] });
      const [, entity, schema] = s.write.createEntity.mock.calls[0];
      expect(schema).toBe(SCHEMA);
      expect(entity).toMatchObject({
        ownerId: OWNER,
        type: 'Person',
        label: 'Sarah Chen',
        reviewStatus: 'accepted',
        labelSource: 'speaker_naming',
      });
      expect(entity.aliases).toBeUndefined();
      // The blank segment is skipped; the quote is capped at 500.
      expect(entity.evidence.map((e: { segmentId: string }) => e.segmentId)).toEqual(['s1', 's3', 's4']);
      expect(entity.evidence[0]).toEqual(
        expect.objectContaining({ transcriptId: TRANSCRIPT, segmentId: 's1', segmentRev: 2, startMs: 100, endMs: 900, quote: 'said s1' }),
      );
      expect(entity.evidence[2].quote).toHaveLength(500);

      const [, relation] = s.write.createRelation.mock.calls[0];
      expect(relation).toMatchObject({
        ownerId: OWNER,
        type: 'IDENTIFIED_AS',
        fromSpeakerId: SPEAKER_A,
        toId: 'new-person-1',
        props: { transcriptId: TRANSCRIPT, speakerId: SPEAKER_A },
        valid: null,
        reviewStatus: 'accepted',
      });
      expect(relation.evidence).toEqual(entity.evidence);

      expect(s.audits()).toEqual([
        expect.objectContaining({
          action: SPEAKER_LINKED_ACTION,
          actorUserId: OWNER,
          targetId: TRANSCRIPT,
          meta: { transcriptId: TRANSCRIPT, speakerId: SPEAKER_A, personId: 'new-person-1', createdPerson: true },
        }),
      ]);
      // Never the name.
      expect(JSON.stringify(s.audits())).not.toContain('Sarah');
    });

    it('links to the one existing Person carrying the name, creating nothing', async () => {
      const s = setup({ persons: [{ id: 'p-sarah', label: 'Sarah Chen' }] });
      const summary = await s.run();

      expect(s.write.createEntity).not.toHaveBeenCalled();
      expect(s.write.addAliases).not.toHaveBeenCalled();
      expect(s.write.createRelation.mock.calls[0][1]).toMatchObject({ toId: 'p-sarah' });
      expect(summary).toMatchObject({ linked: 1, created: 0, createdPersonIds: [] });
      expect(s.audits()[0].meta).toEqual({
        transcriptId: TRANSCRIPT,
        speakerId: SPEAKER_A,
        personId: 'p-sarah',
        createdPerson: false,
      });
    });

    it('adds the spelling as a speaker_naming alias when it matched through a differently spelled alias', async () => {
      const s = setup({ persons: [{ id: 'p-sarah', label: 'S. Chen', aliases: ['sarah  chen!'] }] });
      await s.run();
      expect(s.write.addAliases).toHaveBeenCalledWith(expect.anything(), OWNER, 'p-sarah', [
        { alias: 'Sarah Chen', source: 'speaker_naming' },
      ]);
    });

    it('picks deterministically among several matching Persons and records the ambiguity', async () => {
      const s = setup({
        persons: [
          { id: 'p-1', label: 'Sarah Chen', identified: 1, updatedAt: new Date('2026-03-01') },
          { id: 'p-2', label: 'Sarah Chen', identified: 3, updatedAt: new Date('2026-01-01') },
          { id: 'p-3', label: 'sarah chen', identified: 3, updatedAt: new Date('2026-02-01') },
        ],
      });
      await s.run();
      expect(s.write.createRelation.mock.calls[0][1]).toMatchObject({ toId: 'p-3' });
      expect(s.audits()[0].meta).toMatchObject({ personId: 'p-3', ambiguous: true, candidateIds: ['p-3', 'p-2', 'p-1'] });
    });

    it('does nothing when the edge already points at a live Person with that name', async () => {
      const s = setup({ edges: [{ id: 'e-1', speakerId: SPEAKER_A, personId: 'p-sarah', label: 'Sarah Chen' }] });
      const summary = await s.run();
      expect(summary).toMatchObject({ linked: 0, created: 0, unlinked: 0 });
      noWrites(s);
    });

    it('skips a speaker with no citable segment rather than writing an uncited row', async () => {
      const s = setup({ segments: { [SPEAKER_A]: [segment('s1', ' ')] } });
      const summary = await s.run();
      expect(summary).toMatchObject({ linked: 0, created: 0 });
      noWrites(s);
    });

    it('treats a name with nothing comparable left in it as no name', async () => {
      const s = setup({ transcript: { ownerId: OWNER, speakerIdentities: { [SPEAKER_A]: '?!' }, deletedAt: null } });
      await s.run();
      noWrites(s);
    });
  });

  describe('a renamed speaker', () => {
    const renamed = { ownerId: OWNER, speakerIdentities: { [SPEAKER_A]: 'Marcus Webb' }, deletedAt: null };
    const oldEdge = { id: 'e-old', speakerId: SPEAKER_A, personId: 'p-sarah', label: 'Sarah Chen' };

    it('re-points the edge, deleting the stale one with its evidence first', async () => {
      const s = setup({ transcript: renamed, edges: [oldEdge] });
      const summary = await s.run();

      expect(s.tx.kgEvidence.deleteMany).toHaveBeenCalledWith({ where: { subjectKind: 'relation', subjectId: 'e-old' } });
      expect(s.tx.kgRelation.delete).toHaveBeenCalledWith({ where: { id: 'e-old' } });
      expect(s.tx.kgRelation.delete.mock.invocationCallOrder[0]).toBeLessThan(
        s.write.createRelation.mock.invocationCallOrder[0],
      );
      expect(s.write.createRelation.mock.calls[0][1]).toMatchObject({ fromSpeakerId: SPEAKER_A, toId: 'new-person-1' });
      expect(summary).toMatchObject({ linked: 1, created: 1, unlinked: 0 });
    });

    it('deletes the old Person when it was a speaker-naming-only Person with no other ties', async () => {
      const s = setup({ transcript: renamed, edges: [oldEdge] });
      await s.run();
      expect(s.tx.kgEvidence.deleteMany).toHaveBeenCalledWith({ where: { subjectKind: 'entity', subjectId: 'p-sarah' } });
      expect(s.tx.kgEntityAlias.deleteMany).toHaveBeenCalledWith({ where: { entityId: 'p-sarah' } });
      expect(s.tx.kgEntity.delete).toHaveBeenCalledWith({ where: { id: 'p-sarah' } });
    });

    it.each([
      ['a non-speaker-naming alias', 'otherAliases'],
      ['another relation', 'relations'],
      ['an item', 'items'],
      ['a mention', 'mentions'],
      ['a merge', 'merges'],
      ['an entity merged into it', 'mergedFrom'],
      ['a digest', 'digests'],
      ['evidence citing another source', 'foreignEvidence'],
    ])('keeps the old Person when it has %s', async (_label, key) => {
      const s = setup({ transcript: renamed, edges: [oldEdge], counts: { [key]: 1 } });
      await s.run();
      expect(s.tx.kgRelation.delete).toHaveBeenCalledWith({ where: { id: 'e-old' } });
      expect(s.tx.kgEntity.delete).not.toHaveBeenCalled();
    });
  });

  describe('a versioned rename, read from the live row (#405)', () => {
    it('re-points the edge to the live name even though speaker_identities still holds the old one', async () => {
      const s = setup({
        transcript: { ownerId: OWNER, speakerIdentities: { [SPEAKER_A]: 'Sarah Chen' }, deletedAt: null },
        liveNames: { [SPEAKER_A]: 'Marcus Webb' },
        edges: [{ id: 'e-old', speakerId: SPEAKER_A, personId: 'p-sarah', label: 'Sarah Chen' }],
      });
      const summary = await s.run();

      expect(s.write.createEntity.mock.calls[0][1]).toMatchObject({ label: 'Marcus Webb' });
      expect(s.tx.kgRelation.delete).toHaveBeenCalledWith({ where: { id: 'e-old' } });
      expect(summary).toMatchObject({ linked: 1, created: 1, unlinked: 0 });
    });

    it('unlinks a speaker whose live row is back on its placeholder and has no identity', async () => {
      const s = setup({
        transcript: { ownerId: OWNER, speakerIdentities: {}, deletedAt: null },
        liveNames: { [SPEAKER_A]: `Speaker ${SPEAKER_A}` },
        edges: [{ id: 'e-1', speakerId: SPEAKER_A, personId: 'p-sarah', label: 'Sarah Chen' }],
      });
      expect(await s.run()).toMatchObject({ linked: 0, unlinked: 1 });
    });
  });

  describe('a cleared name', () => {
    it('removes the edge, audits the unlink, and applies the same cleanup rule', async () => {
      const s = setup({
        transcript: { ownerId: OWNER, speakerIdentities: {}, deletedAt: null },
        edges: [{ id: 'e-1', speakerId: SPEAKER_A, personId: 'p-sarah', label: 'Sarah Chen' }],
      });
      const summary = await s.run();

      expect(summary).toMatchObject({ linked: 0, created: 0, unlinked: 1 });
      expect(s.tx.kgRelation.delete).toHaveBeenCalledWith({ where: { id: 'e-1' } });
      expect(s.tx.kgEntity.delete).toHaveBeenCalledWith({ where: { id: 'p-sarah' } });
      expect(s.write.createRelation).not.toHaveBeenCalled();
      expect(s.audits()).toEqual([
        expect.objectContaining({
          action: SPEAKER_UNLINKED_ACTION,
          meta: { transcriptId: TRANSCRIPT, speakerId: SPEAKER_A, removedPersonId: 'p-sarah' },
        }),
      ]);
    });
  });
});

describe('effectiveSpeakerNames (#405)', () => {
  const speaker = (id: string, label: string | null, displayName: string) => ({ id, label, displayName });

  it('overlays an identity only on a speaker still on its placeholder', () => {
    const names = effectiveSpeakerNames(
      [speaker('a', 'A', 'Speaker A'), speaker('b', 'B', 'Joe')],
      { a: 'Oscar', b: 'Oscar' },
    );
    // `b` was renamed Oscar → Joe through the versioned path: the correction
    // recorded in the live row outranks the stale identity, as in materialize().
    expect(Object.fromEntries(names)).toEqual({ a: 'Oscar', b: 'Joe' });
  });

  it('reads a live name that has no identity entry (a versioned rename, a created speaker)', () => {
    const names = effectiveSpeakerNames(
      [speaker('a', 'A', 'Marcus Webb'), speaker('c', null, 'Guest')],
      {},
    );
    expect(Object.fromEntries(names)).toEqual({ a: 'Marcus Webb', c: 'Guest' });
  });

  it('gives a placeholder speaker no name', () => {
    expect(effectiveSpeakerNames([speaker('a', 'A', 'Speaker A')], {}).size).toBe(0);
    expect(effectiveSpeakerNames([speaker('a', 'A', 'Speaker A')], 'garbage').size).toBe(0);
  });
});

describe('pickPerson', () => {
  const candidate = (id: string, identifiedCount: number, updatedAt: string): PersonCandidate => ({
    id,
    label: 'x',
    aliases: [],
    identifiedCount,
    updatedAt: new Date(updatedAt),
  });

  it('is null for no candidates, and not ambiguous for one', () => {
    expect(pickPerson([])).toBeNull();
    expect(pickPerson([candidate('a', 0, '2026-01-01')])).toEqual(
      expect.objectContaining({ ambiguous: false, candidateIds: ['a'] }),
    );
  });

  it('breaks a full tie on the lowest id, whatever the input order', () => {
    const a = candidate('a', 1, '2026-01-01');
    const b = candidate('b', 1, '2026-01-01');
    expect(pickPerson([b, a])?.person.id).toBe('a');
    expect(pickPerson([a, b])?.person.id).toBe('a');
  });
});

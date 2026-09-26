import {
  IDS,
  known,
  makeContext,
  makeInput,
  schemaFor,
} from '../../../test/graph/extraction-fixtures';
import {
  MAX_KNOWN_ENTITIES,
  buildExtractionContext,
  namesADate,
  selectKnownEntities,
} from './extraction-context';

describe('buildExtractionContext (#363)', () => {
  describe('aliases', () => {
    it('assigns s1…sN in the order the segments were given (ordinal order), stably', () => {
      const a = makeContext();
      const b = makeContext();
      expect(a.segments.map((s) => s.alias)).toEqual(['s1', 's2', 's3']);
      expect(a.segments.map((s) => s.segmentId)).toEqual([IDS.seg1, IDS.seg2, IDS.seg3]);
      expect([...a.segmentAlias.keys()]).toEqual([...b.segmentAlias.keys()]);
      expect(a.segmentAlias.get('s1')).toEqual(expect.objectContaining({ segmentId: IDS.seg1, rev: 3, startMs: 0, endMs: 5000 }));
    });

    it('names each line with the speaker name, falling back to the placeholder', () => {
      const ctx = makeContext();
      expect(ctx.segments[0].speakerName).toBe('Sarah Chen');
      expect(ctx.segments[1].speakerName).toBe('Speaker B');
    });

    it('assigns k1…kM to known entities and maps them back to ids', () => {
      const ctx = makeContext();
      expect(ctx.knownEntities.map((k) => k.alias)).toEqual(['k1', 'k2', 'k3']);
      expect(ctx.knownAlias.get('k1')).toBe(IDS.sarah);
      expect(ctx.knownById.get(IDS.northwind)?.alias).toBe('k2');
    });

    it('links an identified speaker to its known alias', () => {
      const ctx = makeContext();
      expect(ctx.speakers[0]).toEqual(expect.objectContaining({ name: 'Sarah Chen', knownAlias: 'k1', firstSegmentAlias: 's1' }));
      expect(ctx.speakers[1]).toEqual(expect.objectContaining({ name: null, knownAlias: null, firstSegmentAlias: 's2' }));
    });
  });

  describe('known entities', () => {
    it('orders pinned → speaker persons → organizations → context matches → recently mentioned, deduplicated', () => {
      const input = makeInput({
        guidance: { pinnedEntityIds: ['p-pin'], instructions: '' },
        knownEntityCandidates: {
          pinned: [known('p-pin', 'Project', 'Pinned project')],
          speakerPersons: [known(IDS.sarah, 'Person', 'Sarah Chen')],
          organizations: [known(IDS.northwind, 'Organization', 'Northwind Robotics'), known(IDS.sarah, 'Person', 'Sarah Chen')],
          contextPool: [known(IDS.pilot, 'Project', 'Pick-path pilot', { aliases: ['pilot'] }), known('x', 'Person', 'Nobody Here')],
          recentlyMentioned: [known('r1', 'Organization', 'Recent Org'), known('p-pin', 'Project', 'Pinned project')],
        },
      });
      expect(selectKnownEntities(input).map((r) => r.id)).toEqual(['p-pin', IDS.sarah, IDS.northwind, IDS.pilot, 'r1']);
    });

    it(`caps the list at ${MAX_KNOWN_ENTITIES}`, () => {
      const many = Array.from({ length: 80 }, (_, i) => known(`r${i}`, 'Organization', `Org ${i}`));
      const input = makeInput({
        knownEntityCandidates: { pinned: [], speakerPersons: [], organizations: [], contextPool: [], recentlyMentioned: many },
      });
      expect(buildExtractionContext(input).knownEntities).toHaveLength(MAX_KNOWN_ENTITIES);
    });

    it('excludes merged and unreviewed entities, and types outside the effective schema', () => {
      const input = makeInput({
        effectiveSchema: schemaFor(['core']),
        knownEntityCandidates: {
          pinned: [],
          speakerPersons: [known('m', 'Person', 'Merged', { mergedIntoId: IDS.sarah }), known('u', 'Person', 'Unreviewed', { reviewStatus: 'unreviewed' })],
          organizations: [known('e', 'Organization', 'Edited', { reviewStatus: 'edited' })],
          contextPool: [],
          recentlyMentioned: [known('p', 'Project', 'Work-only type')],
        },
      });
      expect(selectKnownEntities(input).map((r) => r.id)).toEqual(['e']);
    });

    it('matches Context text whole-word and normalized, never as a substring', () => {
      const input = makeInput({
        note: { ...makeInput().note, contextText: 'Follow-up with ACME, not acmeCorp.' },
        knownEntityCandidates: {
          pinned: [],
          speakerPersons: [],
          organizations: [],
          contextPool: [known('acme', 'Organization', 'Acme'), known('acm', 'Organization', 'Acm')],
          recentlyMentioned: [],
        },
      });
      expect(selectKnownEntities(input).map((r) => r.id)).toEqual(['acme']);
    });
  });

  describe('the offered schema', () => {
    it('limits types by guidance, and relation types by guidance', () => {
      const ctx = makeContext({ guidance: { pinnedEntityIds: [], entityTypes: ['Person', 'Commitment'], relationTypes: ['ATTENDED'], instructions: '' } });
      expect(ctx.offered.entityTypes.map((t) => t.key)).toEqual(['Person']);
      expect(ctx.offered.itemTypes.map((t) => t.key)).toEqual(['Commitment']);
      expect(ctx.offered.relationTypes.map((r) => r.type.key)).toEqual(['ATTENDED']);
    });

    it('never offers Meeting as a type, but keeps it as a relation endpoint', () => {
      const ctx = makeContext();
      expect(ctx.offered.entityTypes.map((t) => t.key)).not.toContain('Meeting');
      const discussed = ctx.offered.relationTypes.find((r) => r.type.key === 'DISCUSSED');
      expect(discussed?.from).toEqual(['Meeting']);
    });

    it('offers only edge relations that are extractable', () => {
      const keys = makeContext().offered.relationTypes.map((r) => r.type.key);
      expect(keys).toEqual(expect.arrayContaining(['WORKS_FOR', 'HAS_ROLE', 'REPORTS_TO', 'ATTENDED', 'DISCUSSED', 'PART_OF']));
      for (const hidden of ['ABOUT', 'IDENTIFIED_AS', 'MENTIONS', 'SUPPORTED_BY', 'ASSIGNED_TO', 'CREATED_IN']) {
        expect(keys).not.toContain(hidden);
      }
    });

    it('drops a disabled domain entirely', () => {
      const ctx = makeContext({ effectiveSchema: schemaFor(['core']) });
      expect(ctx.offered.entityTypes.map((t) => t.key)).toEqual(['Person', 'Organization']);
      expect(ctx.offered.itemTypes.map((t) => t.key)).toEqual(['Claim', 'PersonFact']);
      expect(ctx.offered.relationTypes).toEqual([]);
    });
  });

  describe('meeting date', () => {
    it('uses the recording date, and calls it note_created_at when nobody changed it and Context names no date', () => {
      const ctx = makeContext();
      expect(ctx.meetingDate).toBe('2026-03-02');
      expect(ctx.dateSource).toBe('note_created_at');
    });

    it('is stated when the recording date was corrected (#352)', () => {
      const input = makeInput();
      input.transcript = { ...input.transcript!, recordedAt: new Date('2026-02-20T10:00:00.000Z') };
      const ctx = buildExtractionContext(input);
      expect(ctx.meetingDate).toBe('2026-02-20');
      expect(ctx.dateSource).toBe('stated');
    });

    it('is stated when the Context text names a date', () => {
      const input = makeInput();
      input.note = { ...input.note, contextText: 'Call held on March 2nd with Northwind.' };
      expect(buildExtractionContext(input).dateSource).toBe('stated');
      expect(namesADate('see you 2026-03-02')).toBe(true);
      expect(namesADate('3/2/2026')).toBe(true);
      expect(namesADate('no date here, may be later')).toBe(false);
    });

    it('falls back to the note creation date for a note-only meeting, which has no s# lines', () => {
      const ctx = makeContext({ transcript: null, segments: [], speakers: [] });
      expect(ctx.meetingDate).toBe('2026-03-04');
      expect(ctx.dateSource).toBe('note_created_at');
      expect(ctx.segments).toEqual([]);
      expect(ctx.segmentAlias.size).toBe(0);
      expect(ctx.meetingTitle).toBe('Pilot kickoff');
    });
  });

  describe('guidance', () => {
    it('is null when it asks for nothing the prompt must show', () => {
      expect(makeContext({ guidance: { pinnedEntityIds: [], entityTypes: ['Person'], instructions: '  ' } }).guidance).toBeNull();
    });

    it('carries pinned aliases and trimmed instructions', () => {
      const input = makeInput({ guidance: { pinnedEntityIds: [IDS.pilot], instructions: '  Focus on the pilot. ' } });
      input.knownEntityCandidates.pinned = [known(IDS.pilot, 'Project', 'Pick-path pilot')];
      expect(buildExtractionContext(input).guidance).toEqual({ pinnedAliases: ['k1'], instructions: 'Focus on the pilot.' });
    });
  });
});

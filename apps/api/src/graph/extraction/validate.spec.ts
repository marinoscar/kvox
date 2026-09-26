import { statementHash } from '../write/normalize';
import { IDS, NOTE_BODY, SEGMENT_TEXT, goodAnswer, makeContext } from '../../../test/graph/extraction-fixtures';
import {
  WHOLE_SEGMENT_QUOTE_CHARS,
  addDeterministicRows,
  locateQuote,
  normalizeIsoDate,
  validateExtraction,
  type ProposedRow,
  type ValidationResult,
} from './validate';

type Ok = Extract<ValidationResult, { ok: true }>;

function ok(result: ValidationResult): Ok {
  if (!result.ok) throw new Error(`expected ok, got ${result.message}`);
  return result;
}

const byRef = (rows: ProposedRow[], ref: string) => rows.find((r) => r.payload.ref === ref);

describe('validateExtraction (#363)', () => {
  it('accepts a well-formed answer with every row cited', () => {
    const result = ok(validateExtraction(goodAnswer(), makeContext()));
    expect(result.stats.proposed).toEqual({ entities: 2, relations: 1, items: 2 });
    expect(result.stats.dropped).toEqual({ uncited: 0, invalid: 0, unknownType: 0, dangling: 0 });
    expect(result.topics).toEqual(['warehouse throughput']);
    for (const row of result.rows) expect(row.evidence.length).toBeGreaterThan(0);
  });

  it('a malformed answer is invalid_output, never partial', () => {
    for (const bad of [null, 'not json', { entities: 'nope' }, { entities: [{ ref: 'e1' }] }]) {
      const result = validateExtraction(bad, makeContext());
      expect(result).toEqual(expect.objectContaining({ ok: false, errorClass: 'invalid_output' }));
    }
  });

  describe('citations', () => {
    it('drops a cite to an id the model was never handed, and the row with it', () => {
      const answer = goodAnswer();
      answer.entities[1].evidence = [{ source: 's99', quote: 'anything' }];
      const result = ok(validateExtraction(answer, makeContext()));
      expect(byRef(result.rows, 'e1')).toBeUndefined();
      expect(result.stats.dropped.uncited).toBe(1);
      expect(JSON.stringify(result.rows)).not.toContain('s99');
    });

    it('locates a quote in the segment and records offsets within the segment text', () => {
      const result = ok(validateExtraction(goodAnswer(), makeContext()));
      const sarah = byRef(result.rows, 'k1')!;
      const ev = sarah.evidence[0];
      expect(ev).toEqual(
        expect.objectContaining({ source: 'segment', segmentId: IDS.seg1, segmentRev: 3, transcriptId: IDS.transcript, startMs: 0, endMs: 5000 }),
      );
      if (ev.source !== 'segment') throw new Error('segment evidence expected');
      expect(SEGMENT_TEXT.s1.slice(ev.charStart!, ev.charEnd!)).toBe("I'm Sarah Chen, VP of Operations");
      expect(ev.quote).toBe("I'm Sarah Chen, VP of Operations");
    });

    it('locates a quote case- and whitespace-insensitively, quoting the source text', () => {
      const result = ok(validateExtraction(goodAnswer(), makeContext()));
      const decision = result.rows.find((r) => r.kind === 'item' && r.payload.kind === 'decision')!;
      expect(decision.evidence[0].quote).toBe('We decided to go with Postgres');
      expect(decision.flags).not.toContain('quote_not_located');
    });

    it('a real segment whose quote is not found becomes whole-segment evidence, flagged', () => {
      const answer = goodAnswer();
      answer.items[0].evidence = [{ source: 's3', quote: 'a paraphrase nobody said' }];
      const result = ok(validateExtraction(answer, makeContext()));
      const commitment = result.rows.find((r) => r.kind === 'item' && r.payload.kind === 'commitment')!;
      expect(commitment.flags).toContain('quote_not_located');
      expect(commitment.evidence[0]).toEqual(
        expect.objectContaining({ source: 'segment', charStart: null, charEnd: null, quote: SEGMENT_TEXT.s3.slice(0, WHOLE_SEGMENT_QUOTE_CHARS) }),
      );
      expect(result.stats.quoteNotLocated).toBe(1);
    });

    it('drops a note cite whose quote is not in the body', () => {
      const answer = goodAnswer();
      answer.entities[1].evidence = [{ source: 'N', quote: 'This sentence is not in the note.' }];
      const result = ok(validateExtraction(answer, makeContext()));
      expect(byRef(result.rows, 'e1')).toBeUndefined();
      expect(result.stats.dropped.uncited).toBe(1);
    });

    it('records a note cite with offsets into that version\'s body', () => {
      const result = ok(validateExtraction(goodAnswer(), makeContext()));
      const ev = byRef(result.rows, 'e1')!.evidence[0];
      if (ev.source !== 'note') throw new Error('note evidence expected');
      expect(ev).toEqual(expect.objectContaining({ noteId: IDS.note, noteVersion: 2 }));
      expect(NOTE_BODY.slice(ev.charStart, ev.charEnd)).toBe('Decision: use Postgres.');
    });

    it('s# cites are refused for a note-only meeting', () => {
      const ctx = makeContext({ transcript: null, segments: [], speakers: [] });
      const result = ok(validateExtraction(goodAnswer(), ctx));
      // Only the note-cited project survives; every row resting on s# lines is uncited.
      expect(result.rows.map((r) => r.payload.ref)).toEqual(['e1']);
      expect(result.stats.dropped.uncited).toBe(4);
    });
  });

  describe('drops, counted', () => {
    it('an uncited row is dropped', () => {
      const answer = goodAnswer();
      answer.items[1].evidence = [];
      const result = ok(validateExtraction(answer, makeContext()));
      expect(result.rows.filter((r) => r.kind === 'item')).toHaveLength(1);
      expect(result.stats.dropped.uncited).toBe(1);
    });

    it('cascades a dropped entity to every relation and item that names it (dangling)', () => {
      const answer = goodAnswer();
      answer.entities[1].evidence = []; // e1: both items name it as subject
      const result = ok(validateExtraction(answer, makeContext()));
      expect(result.rows.filter((r) => r.kind === 'item')).toHaveLength(0);
      expect(result.stats.dropped).toEqual({ uncited: 1, invalid: 0, unknownType: 0, dangling: 2 });
      // The relation between two KNOWN entities is untouched.
      expect(result.rows.filter((r) => r.kind === 'relation')).toHaveLength(1);
    });

    it('an endpoint that names no row at all is dangling', () => {
      const answer = goodAnswer();
      answer.relations[0].to = 'e42';
      const result = ok(validateExtraction(answer, makeContext()));
      expect(result.stats.dropped.dangling).toBe(1);
    });

    it('a type that was not offered is unknownType', () => {
      const answer = goodAnswer();
      answer.entities.push({ ...answer.entities[1], ref: 'e2', type: 'Team' });
      answer.relations.push({ ...answer.relations[0], type: 'RELATED_TO' });
      const ctx = makeContext({ guidance: { pinnedEntityIds: [], entityTypes: ['Person', 'Organization', 'Project', 'Commitment'], instructions: '' } });
      const result = ok(validateExtraction(answer, ctx));
      // Team, RELATED_TO, and the decision (Decision excluded by guidance).
      expect(result.stats.dropped.unknownType).toBe(3);
    });

    it('props that break the closed schema are invalid', () => {
      const answer = goodAnswer();
      (answer.entities[0].props as Record<string, unknown>).favouriteColour = 'blue';
      (answer.entities[1].props as Record<string, unknown>).status = 'maybe';
      const result = ok(validateExtraction(answer, makeContext()));
      expect(result.stats.dropped.invalid).toBe(2);
      expect(result.stats.proposed.entities).toBe(0);
    });

    it('keeps only stated props (null means "not stated")', () => {
      const result = ok(validateExtraction(goodAnswer(), makeContext()));
      expect(byRef(result.rows, 'e1')!.payload).toEqual(expect.objectContaining({ props: {} }));
      expect(byRef(result.rows, 'k1')!.payload).toEqual(expect.objectContaining({ props: { title: 'VP of Operations' } }));
    });

    it('an endpoint of the wrong type is invalid', () => {
      const answer = goodAnswer();
      answer.relations[0].from = 'k2'; // WORKS_FOR from an Organization
      answer.items[0].owner = 'k2'; // a commitment owned by an Organization
      const result = ok(validateExtraction(answer, makeContext()));
      expect(result.stats.dropped.invalid).toBe(2);
    });

    it('a commitment without an owner is invalid', () => {
      const answer = goodAnswer();
      answer.items[0].owner = null as unknown as string;
      expect(ok(validateExtraction(answer, makeContext())).stats.dropped.invalid).toBe(1);
    });

    it('a claimed known id that was never handed out is invalid', () => {
      const answer = goodAnswer();
      answer.entities.push({ ...answer.entities[0], ref: 'k99' });
      expect(ok(validateExtraction(answer, makeContext())).stats.dropped.invalid).toBe(1);
    });

    it('validFrom after validTo is dropped, never swapped', () => {
      const answer = goodAnswer();
      Object.assign(answer.relations[0], { validFrom: '2026-05-01', validTo: '2026-01-01', precision: 'day' });
      const result = ok(validateExtraction(answer, makeContext()));
      expect(result.rows.filter((r) => r.kind === 'relation')).toHaveLength(0);
      expect(result.stats.dropped.invalid).toBe(1);
    });

    it('an unparseable date becomes null with precision unknown', () => {
      const answer = goodAnswer();
      Object.assign(answer.relations[0], { validFrom: 'next spring', validTo: null, precision: 'day' });
      answer.items[0].dueAt = 'Friday';
      const result = ok(validateExtraction(answer, makeContext()));
      const rel = result.rows.find((r) => r.kind === 'relation')!;
      expect(rel.payload).toEqual(expect.objectContaining({ validFrom: null, validTo: null, precision: 'unknown' }));
      const commitment = result.rows.find((r) => r.kind === 'item' && r.payload.kind === 'commitment')!;
      expect(commitment.payload).toEqual(expect.objectContaining({ dueAt: null }));
    });
  });

  describe('rows', () => {
    it('a re-stated known entity links to it, flagged model_claimed_match, and endpoints point at the entity', () => {
      const result = ok(validateExtraction(goodAnswer(), makeContext()));
      const sarah = byRef(result.rows, 'k1')!;
      expect(sarah.flags).toContain('model_claimed_match');
      expect(sarah.resolution).toEqual({ ref: IDS.sarah, score: null, source: 'model', candidates: [], adjudication: null });
      const rel = result.rows.find((r) => r.kind === 'relation')!;
      expect(rel.payload).toEqual(expect.objectContaining({ from: { entityId: IDS.sarah }, to: { entityId: IDS.northwind } }));
    });

    it('items carry the #355 statement hash, and commitments/decisions the meeting', () => {
      const result = ok(validateExtraction(goodAnswer(), makeContext()));
      const commitment = result.rows.find((r) => r.kind === 'item' && r.payload.kind === 'commitment')!;
      expect(commitment.payload).toEqual(
        expect.objectContaining({
          statementHash: statementHash('commitment', 'Sarah will send the updated proposal by Friday.'),
          meeting: { ref: 'meeting' },
          owner: { entityId: IDS.sarah },
          subject: { ref: 'e1' },
          status: 'open',
          dueAt: '2026-03-06',
        }),
      );
    });

    it('a person fact without sensitivity takes the type default; a sensitive one is flagged', () => {
      const answer = goodAnswer();
      const base = { ...answer.items[1], kind: 'person_fact', subject: 'k1', props: {}, evidence: answer.items[0].evidence };
      answer.items = [
        { ...base, title: 'Runs', statement: 'Sarah runs marathons.', sensitivity: null },
        { ...base, title: 'Health', statement: 'Sarah is recovering from surgery.', sensitivity: 'sensitive' },
      ];
      const result = ok(validateExtraction(answer, makeContext()));
      const [runs, health] = result.rows.filter((r) => r.kind === 'item');
      expect(runs.payload).toEqual(expect.objectContaining({ sensitivity: 'personal', meeting: null }));
      expect(health.payload).toEqual(expect.objectContaining({ sensitivity: 'sensitive' }));
      expect(health.flags).toContain('sensitive');
    });
  });
});

describe('addDeterministicRows (#363)', () => {
  it('adds the Meeting row first and ATTENDED for each identified speaker', () => {
    const ctx = makeContext({ existingMeeting: { id: IDS.meeting } });
    const result = addDeterministicRows(ctx, ok(validateExtraction(goodAnswer(), ctx)));
    const meeting = result.rows[0];
    expect(meeting.kind).toBe('entity');
    expect(meeting.payload).toEqual(
      expect.objectContaining({
        ref: 'meeting',
        type: 'Meeting',
        label: 'Pilot kickoff call',
        occurredAt: '2026-03-02',
        props: { dateSource: 'note_created_at', noteId: IDS.note, transcriptId: IDS.transcript, topics: ['warehouse throughput'] },
      }),
    );
    expect(meeting.resolution).toEqual(expect.objectContaining({ ref: IDS.meeting, score: 1, source: 'meeting' }));
    // The first line any row cites.
    expect(meeting.evidence[0]).toEqual(expect.objectContaining({ segmentId: IDS.seg1, charStart: null }));

    const attended = result.rows.filter((r) => r.kind === 'relation' && r.payload.type === 'ATTENDED');
    // Speaker A is identified (Sarah); speaker B is not.
    expect(attended).toHaveLength(1);
    expect(attended[0].payload).toEqual(expect.objectContaining({ from: { entityId: IDS.sarah }, to: { ref: 'meeting' } }));
    expect(attended[0].evidence[0]).toEqual(expect.objectContaining({ segmentId: IDS.seg1 }));
    expect(result.stats.proposed.entities).toBe(3);
    expect(result.stats.proposed.relations).toBe(2);
    // Refs stay unique.
    const refs = result.rows.map((r) => `${r.kind}:${r.payload.ref}`);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('does not add a second ATTENDED when the model proposed one for the same person', () => {
    const ctx = makeContext();
    const answer = goodAnswer();
    answer.relations.push({ ...answer.relations[0], type: 'ATTENDED', from: 'k1', to: 'meeting' });
    const result = addDeterministicRows(ctx, ok(validateExtraction(answer, ctx)));
    expect(result.rows.filter((r) => r.kind === 'relation' && r.payload.type === 'ATTENDED')).toHaveLength(1);
  });

  it('links a named but unlinked speaker to a proposed Person with that name', () => {
    const input = { speakers: [{ id: IDS.spkA, label: 'A', displayName: 'Tomás Aguilar', personEntityId: null }] };
    const ctx = makeContext(input);
    const answer = goodAnswer();
    answer.entities.push({ ref: 'e2', type: 'Person', label: 'Tomás Aguilar', aliases: [], props: { title: null }, evidence: [{ source: 's1', quote: 'Hi everyone' }] });
    const result = addDeterministicRows(ctx, ok(validateExtraction(answer, ctx)));
    const attended = result.rows.filter((r) => r.kind === 'relation' && r.payload.type === 'ATTENDED');
    expect(attended.map((r) => (r.payload as { from: unknown }).from)).toEqual([{ ref: 'e2' }]);
  });

  it('a note-only meeting cites the note title span and adds no ATTENDED', () => {
    const ctx = makeContext({ transcript: null, segments: [], speakers: [] });
    const result = addDeterministicRows(ctx, ok(validateExtraction(goodAnswer(), ctx)));
    const ev = result.rows[0].evidence[0];
    if (ev.source !== 'note') throw new Error('note evidence expected');
    expect(NOTE_BODY.slice(ev.charStart, ev.charEnd)).toBe('Pilot kickoff');
    expect(result.rows[0].payload).toEqual(expect.objectContaining({ props: expect.not.objectContaining({ transcriptId: expect.anything() }) }));
    expect(result.rows.some((r) => r.kind === 'relation' && r.payload.type === 'ATTENDED')).toBe(false);
  });
});

describe('helpers', () => {
  it('locateQuote: exact, then case/whitespace-folded, else null', () => {
    expect(locateQuote('Hello  World', 'Hello  World')).toEqual({ start: 0, end: 12 });
    expect(locateQuote('Say Hello\n  World now', 'hello world')).toEqual({ start: 4, end: 17 });
    expect(locateQuote('abc', 'xyz')).toBeNull();
    expect(locateQuote('abc', '   ')).toBeNull();
  });

  it('normalizeIsoDate widens partial dates and refuses impossible ones', () => {
    expect(normalizeIsoDate('2026-03-06')).toBe('2026-03-06');
    expect(normalizeIsoDate('2026-03')).toBe('2026-03-01');
    expect(normalizeIsoDate('2026')).toBe('2026-01-01');
    expect(normalizeIsoDate('2026-02-30')).toBeNull();
    expect(normalizeIsoDate('Friday')).toBeNull();
    expect(normalizeIsoDate(null)).toBeNull();
  });
});

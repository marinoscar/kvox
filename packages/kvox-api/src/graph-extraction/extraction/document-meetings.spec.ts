// A document or record that holds several meetings (#780, epic #773).

import { IDS, makeContext, makeInput } from '../testing/extraction-fixtures.js';
import { assembleExtractionPrompt, documentMeetingsRule } from './prompt.js';
import { mergeChunkResults } from './merge-chunks.js';
import { addDeterministicRows, validateExtraction, type EvidenceDraft, type ProposedRow, type ValidationResult } from './validate.js';

const BODY = [
  '# Account record',
  '',
  '## Kickoff workshop',
  'Date: 3 March 2026.',
  'Avery Example convened the workshop. Blair Sample attended.',
  'Action: Blair Sample sends the site list to Avery Example.',
  '',
  '## Pricing review',
  'Date: 17 March 2026.',
  'Casey Demo hosted the review. Blair Sample was only copied.',
  'Action: Casey Demo drafts the price sheet.',
].join('\n');

const SELF = 'self-person-id';

const documentContext = (over: Parameters<typeof makeInput>[0] = {}) =>
  makeContext({
    transcript: null,
    segments: [],
    speakers: [],
    sourceType: 'document',
    note: { id: IDS.note, title: 'Account record', bodyAtVersion: BODY, version: 1, contextText: null, createdAt: new Date('2026-04-01T09:00:00Z') },
    knownEntityCandidates: { pinned: [], speakerPersons: [], organizations: [], contextPool: [], recentlyMentioned: [] },
    ...over,
  });

const cite = (quote: string) => [{ source: 'N', quote }];
const entity = (ref: string, type: string, label: string, quote: string, props: Record<string, unknown> = {}) => ({
  ref, type, label, aliases: [], props, evidence: cite(quote),
});
const relation = (type: string, from: string, to: string, quote: string, props: Record<string, unknown> = {}) => ({
  type, from, to, props, validFrom: null, validTo: null, precision: 'unknown', evidence: cite(quote),
});
const commitment = (title: string, owner: string, quote: string) => ({
  kind: 'commitment', title, statement: quote, subject: owner, owner, counterparty: null, status: 'open', occurredAt: null,
  dueAt: null, validFrom: null, validTo: null, precision: 'unknown', sensitivity: null, props: {}, evidence: cite(quote),
});

const meetingEntities = [
  entity('e1', 'Meeting', 'Kickoff workshop', '## Kickoff workshop', { occurredOn: '2026-03-03', meetingKind: 'client' }),
  entity('e2', 'Meeting', 'Pricing review', '## Pricing review', { occurredOn: '2026-03-17', meetingKind: 'client' }),
  entity('e3', 'Person', 'Avery Example', 'Avery Example convened the workshop'),
  entity('e4', 'Person', 'Blair Sample', 'Blair Sample attended'),
  entity('e5', 'Person', 'Casey Demo', 'Casey Demo hosted the review'),
];
const meetingRelations = [
  relation('ORGANIZED', 'e3', 'e1', 'Avery Example convened the workshop'),
  relation('ATTENDED', 'e4', 'e1', 'Blair Sample attended', { attendance: 'attended' }),
  relation('ORGANIZED', 'e5', 'e2', 'Casey Demo hosted the review'),
  relation('ATTENDED', 'e4', 'e2', 'Blair Sample was only copied', { attendance: 'copied' }),
];
const items = [
  commitment('Send site list', 'e4', 'Blair Sample sends the site list to Avery Example'),
  commitment('Draft price sheet', 'e5', 'Casey Demo drafts the price sheet'),
];

function run(ctx: ReturnType<typeof documentContext>, entities: unknown[], relations: unknown[], list: unknown[]) {
  const validated = validateExtraction({ meeting: { topics: [] }, entities, relations, items: list }, ctx) as Extract<ValidationResult, { ok: true }>;
  expect(validated.ok).toBe(true);
  return { validated, final: addDeterministicRows(ctx, validated) };
}

const entitiesOf = (rows: ProposedRow[], type: string) => rows.filter((r) => r.kind === 'entity' && r.payload.type === type);
const relationsOf = (rows: ProposedRow[], type: string) =>
  rows.filter((r): r is Extract<ProposedRow, { kind: 'relation' }> => r.kind === 'relation' && r.payload.type === type);

describe('document-origin context', () => {
  it('offers Meeting for a document and never for a transcript', () => {
    expect(documentContext().offered.entityTypes.map((t) => t.key)).toContain('Meeting');
    expect(makeContext().offered.entityTypes.map((t) => t.key)).not.toContain('Meeting');
    expect(documentContext().documentOrigin).toBe(true);
    expect(makeContext().documentOrigin).toBe(false);
  });

  it('a note with a transcript behind it is not document-origin, whatever its source type says', () => {
    expect(makeContext({ sourceType: 'document' }).documentOrigin).toBe(false);
  });

  it('carries selfEntityId, defaulting to null', () => {
    expect(documentContext().selfEntityId).toBeNull();
    expect(documentContext({ selfEntityId: SELF }).selfEntityId).toBe(SELF);
  });

  it('states the several-meetings rule for a document only', () => {
    const doc = assembleExtractionPrompt(documentContext());
    expect(doc.systemPrompt).toContain(documentMeetingsRule(documentContext()));
    expect(doc.systemPrompt).toContain('ORGANIZED');
    expect(documentMeetingsRule(makeContext())).toBeNull();
    expect(assembleExtractionPrompt(makeContext()).systemPrompt).not.toContain('several meetings');
  });
});

describe('addDeterministicRows for a document (#780)', () => {
  it('two proposed meetings replace the system Meeting; facts follow the meeting they were cited under', () => {
    const ctx = documentContext();
    const { final } = run(ctx, meetingEntities, meetingRelations, items.map((i) => ({ ...i })));
    const meetings = entitiesOf(final.rows, 'Meeting');
    expect(meetings.map((m) => m.payload.ref)).toEqual(['e1', 'e2']);
    expect(meetings.map((m) => (m.payload as { occurredAt: string | null }).occurredAt)).toEqual(['2026-03-03', '2026-03-17']);
    expect(final.rows.some((r) => r.payload.ref === 'meeting')).toBe(false);
    const meetingOf = (title: string) =>
      (final.rows.find((r) => r.kind === 'item' && r.payload.title === title)!.payload as { meeting: unknown }).meeting;
    expect(meetingOf('Send site list')).toEqual({ ref: 'e1' });
    expect(meetingOf('Draft price sheet')).toEqual({ ref: 'e2' });
    expect(relationsOf(final.rows, 'ORGANIZED')).toHaveLength(2);
    expect(relationsOf(final.rows, 'ATTENDED').map((r) => r.payload.props)).toEqual([{ attendance: 'attended' }, { attendance: 'copied' }]);
    const refs = final.rows.map((r) => `${r.kind}:${r.payload.ref}`);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('adds one cited Document with RECORDED_IN from each meeting, and no PREPARED_FOR without a self entity', () => {
    const { final } = run(documentContext(), meetingEntities, meetingRelations, []);
    const docs = entitiesOf(final.rows, 'Document');
    expect(docs).toHaveLength(1);
    expect(docs[0].payload).toEqual(expect.objectContaining({ ref: 'document', label: 'Account record', props: { title: 'Account record' } }));
    const ev = docs[0].evidence[0] as Extract<EvidenceDraft, { source: 'note' }>;
    expect(ev.source).toBe('note');
    expect(BODY.slice(ev.charStart!, ev.charEnd!)).toBe('Account record');
    const recorded = relationsOf(final.rows, 'RECORDED_IN');
    expect(recorded.map((r) => [r.payload.from, r.payload.to])).toEqual([
      [{ ref: 'e1' }, { ref: 'document' }],
      [{ ref: 'e2' }, { ref: 'document' }],
    ]);
    for (const r of recorded) expect(r.evidence.length).toBeGreaterThan(0);
    expect(relationsOf(final.rows, 'PREPARED_FOR')).toHaveLength(0);
  });

  it('adds PREPARED_FOR to the owner only when a self entity id is supplied, and states preparedOn only for a stated date', () => {
    const { final } = run(documentContext({ selfEntityId: SELF }), meetingEntities, meetingRelations, []);
    const prepared = relationsOf(final.rows, 'PREPARED_FOR');
    expect(prepared).toHaveLength(1);
    expect(prepared[0].payload.from).toEqual({ ref: 'document' });
    expect(prepared[0].payload.to).toEqual({ entityId: SELF });
    expect(prepared[0].evidence.length).toBeGreaterThan(0);
    expect(entitiesOf(final.rows, 'Document')[0].payload).toEqual(expect.objectContaining({ props: { title: 'Account record' } }));

    const stated = documentContext({
      note: { id: IDS.note, title: 'Account record', bodyAtVersion: BODY, version: 1, contextText: 'Prepared on 1 April 2026.', createdAt: new Date('2026-04-01T09:00:00Z') },
    });
    const doc = entitiesOf(run(stated, meetingEntities, meetingRelations, []).final.rows, 'Document')[0];
    expect(doc.payload).toEqual(expect.objectContaining({ props: { title: 'Account record', preparedOn: '2026-04-01' } }));
  });

  it('fewer than two proposed meetings keep the system Meeting, folding a lone proposed one into it', () => {
    const ctx = documentContext();
    const { final } = run(
      ctx,
      [meetingEntities[0], meetingEntities[2], meetingEntities[3]],
      [meetingRelations[0], meetingRelations[1]],
      [items[0]],
    );
    expect(entitiesOf(final.rows, 'Meeting').map((m) => m.payload.ref)).toEqual(['meeting']);
    expect(relationsOf(final.rows, 'ORGANIZED')[0].payload.to).toEqual({ ref: 'meeting' });
    expect(relationsOf(final.rows, 'RECORDED_IN')[0].payload.from).toEqual({ ref: 'meeting' });
    expect(final.stats.proposed.entities).toBe(final.rows.filter((r) => r.kind === 'entity').length);
  });

  it('no proposed meeting is exactly today\'s single system Meeting plus the Document', () => {
    const { final } = run(documentContext(), [meetingEntities[2]], [], []);
    expect(entitiesOf(final.rows, 'Meeting').map((m) => m.payload.ref)).toEqual(['meeting']);
    expect(entitiesOf(final.rows, 'Document')).toHaveLength(1);
  });

  it('a transcript note is untouched: no Document, no document rows', () => {
    const ctx = makeContext();
    const validated = validateExtraction({ meeting: { topics: [] }, entities: [], relations: [], items: [] }, ctx) as Extract<ValidationResult, { ok: true }>;
    const final = addDeterministicRows(ctx, validated);
    expect(entitiesOf(final.rows, 'Document')).toHaveLength(0);
    expect(final.rows.map((r) => r.payload.ref)).toContain('meeting');
  });

  it('refuses a model-proposed entity under the reserved document ref', () => {
    const ctx = documentContext();
    const { validated } = run(ctx, [entity('document', 'Person', 'Avery Example', 'Avery Example convened the workshop')], [], []);
    expect(validated.rows).toHaveLength(0);
    expect(validated.stats.dropped.invalid).toBe(1);
  });
});

describe('mergeChunkResults dedupes meetings by title and date (#780)', () => {
  const ev = (start: number): EvidenceDraft => ({ source: 'note', noteId: 'n', noteVersion: 1, charStart: start, charEnd: start + 3, quote: 'abc' });
  const meeting = (ref: string, label: string, day: string | null, start: number): ProposedRow => ({
    kind: 'entity',
    payload: { ref, type: 'Meeting', label, aliases: [], props: day ? { occurredOn: day } : {}, occurredAt: day },
    resolution: null,
    flags: [],
    evidence: [ev(start)],
  });
  const stats = { proposed: { entities: 1, relations: 0, items: 0 }, dropped: { uncited: 0, invalid: 0, unknownType: 0, dangling: 0 }, quoteNotLocated: 0 };
  const outcome = (rows: ProposedRow[]) => ({ rows, topics: [], stats });

  it('merges one meeting restated in two chunks, ignoring case and punctuation in the title', () => {
    const merged = mergeChunkResults([
      outcome([meeting('e1', 'Kickoff Workshop', '2026-03-03', 0)]),
      outcome([meeting('e1', 'kickoff workshop!', '2026-03-03', 900)]),
    ]);
    expect(entitiesOf(merged.rows, 'Meeting')).toHaveLength(1);
    expect(entitiesOf(merged.rows, 'Meeting')[0].evidence).toHaveLength(2);
  });

  it('keeps two same-titled meetings on different dates apart', () => {
    const merged = mergeChunkResults([
      outcome([meeting('e1', 'Weekly sync', '2026-03-03', 0)]),
      outcome([meeting('e1', 'Weekly sync', '2026-03-10', 900)]),
    ]);
    expect(entitiesOf(merged.rows, 'Meeting').map((m) => m.payload.ref)).toEqual(['e1', 'e2']);
  });

  it('re-points a relation to the merged meeting', () => {
    const attended: ProposedRow = {
      kind: 'relation',
      payload: { ref: 'r1', type: 'ATTENDED', from: { ref: 'e2' }, to: { ref: 'e1' }, props: {}, validFrom: null, validTo: null, precision: 'unknown' },
      resolution: null,
      flags: [],
      evidence: [ev(910)],
    };
    const person: ProposedRow = {
      kind: 'entity', payload: { ref: 'e2', type: 'Person', label: 'Avery Example', aliases: [], props: {}, occurredAt: null },
      resolution: null, flags: [], evidence: [ev(905)],
    };
    const merged = mergeChunkResults([
      outcome([meeting('e1', 'Kickoff', '2026-03-03', 0)]),
      outcome([meeting('e1', 'Kickoff', '2026-03-03', 900), person, attended]),
    ]);
    const rel = relationsOf(merged.rows, 'ATTENDED')[0];
    expect(rel.payload.to).toEqual({ ref: 'e1' });
  });
});

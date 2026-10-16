import { buildBriefSections, buildPeopleChanges, exclusiveRelationTypes, type BriefItemRow, type BriefRelationRow, type BriefSectionInput } from './brief-sections';
import type { BriefEntityRef } from './dto/entity-brief.dto';

// Deterministic ids: the section builder is pure, so readable uuids make failures legible.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACME = id(1);
const SARAH = id(2);
const BOB = id(3);
const MEETING = id(4);
const ev = (n: number) => [id(900 + n)];
const d = (s: string) => new Date(s);

let seq = 100;
function item(over: Partial<BriefItemRow>): BriefItemRow {
  seq += 1;
  return {
    id: id(seq),
    kind: 'claim',
    title: null,
    statement: `statement ${seq}`,
    status: 'active',
    occurredAt: d('2026-09-10T00:00:00Z'),
    dueAt: null,
    precision: null,
    subjectId: null,
    ownerPersonId: null,
    counterpartyId: null,
    meetingId: null,
    reviewStatus: 'accepted',
    supersededById: null,
    supersededByOccurredAt: null,
    sensitivity: null,
    valid: null,
    evidenceIds: ev(seq),
    ...over,
  };
}

function relation(over: Partial<BriefRelationRow>): BriefRelationRow {
  seq += 1;
  return {
    id: id(seq),
    type: 'HAS_ROLE',
    fromId: SARAH,
    toId: ACME,
    props: {},
    validFrom: null,
    validTo: null,
    precision: 'day',
    evidenceIds: ev(seq),
    ...over,
  };
}

const entities = new Map<string, BriefEntityRef>([
  [ACME, { id: ACME, label: 'Acme', type: 'Organization' }],
  [SARAH, { id: SARAH, label: 'Sarah', type: 'Person' }],
  [BOB, { id: BOB, label: 'Bob', type: 'Person' }],
]);

const EXCLUSIVE = exclusiveRelationTypes([
  { key: 'WORKS_FOR', exclusive: 'soft' },
  { key: 'HAS_ROLE', exclusive: 'soft' },
  { key: 'REPORTS_TO', exclusive: 'soft' },
  { key: 'ATTENDED', exclusive: 'none' },
]);

function input(over: Partial<BriefSectionInput>): BriefSectionInput {
  return {
    entity: { id: ACME, type: 'Organization' },
    since: d('2026-09-01T00:00:00Z'),
    asOf: d('2026-09-20T00:00:00Z'),
    items: [],
    relations: [],
    exclusiveTypes: EXCLUSIVE,
    workerIds: new Set(),
    entities,
    ...over,
  };
}

describe('exclusiveRelationTypes', () => {
  it('reads the ontology flag rather than a hardcoded list', () => {
    expect([...EXCLUSIVE].sort()).toEqual(['HAS_ROLE', 'REPORTS_TO', 'WORKS_FOR']);
    expect(exclusiveRelationTypes([{ key: 'CUSTOM_LEAD', exclusive: 'soft' }])).toEqual(new Set(['CUSTOM_LEAD']));
  });
});

describe('buildBriefSections', () => {
  it('puts only items about the entity stated inside (since, asOf] in whatChanged, newest first', () => {
    const inside = item({ subjectId: ACME, occurredAt: d('2026-09-10T00:00:00Z') });
    const newer = item({ meetingId: ACME, kind: 'decision', occurredAt: d('2026-09-15T00:00:00Z') });
    const before = item({ subjectId: ACME, occurredAt: d('2026-08-01T00:00:00Z') });
    const after = item({ subjectId: ACME, occurredAt: d('2026-09-25T00:00:00Z') });
    const elsewhere = item({ subjectId: BOB });
    const s = buildBriefSections(input({ items: [inside, before, after, elsewhere, newer] }));
    expect(s.whatChanged.map((e) => e.itemId)).toEqual([newer.id, inside.id]);
  });

  it('never includes a sensitive person fact in any section, and drops uncited rows', () => {
    const sensitive = item({ kind: 'person_fact', subjectId: SARAH, sensitivity: 'sensitive' });
    const personal = item({ kind: 'person_fact', subjectId: SARAH, sensitivity: 'personal' });
    const uncited = item({ subjectId: SARAH, evidenceIds: [] });
    const s = buildBriefSections(
      input({ entity: { id: SARAH, type: 'Person' }, items: [sensitive, personal, uncited] }),
    );
    const all = JSON.stringify(s);
    expect(all).not.toContain(sensitive.id);
    expect(all).not.toContain(uncited.id);
    expect(s.whatChanged.map((e) => e.itemId)).toEqual([personal.id]);
  });

  it('splits open commitments into theirs (owner) and yours (counterparty) for a Person', () => {
    const theirs = item({ kind: 'commitment', status: 'open', ownerPersonId: SARAH, counterpartyId: BOB });
    const yours = item({ kind: 'commitment', status: 'open', ownerPersonId: BOB, counterpartyId: SARAH });
    const done = item({ kind: 'commitment', status: 'done', ownerPersonId: SARAH });
    const s = buildBriefSections(input({ entity: { id: SARAH, type: 'Person' }, items: [theirs, yours, done] }));
    expect(s.openCommitments.theirs.map((e) => e.itemId)).toEqual([theirs.id]);
    expect(s.openCommitments.yours.map((e) => e.itemId)).toEqual([yours.id]);
    expect(s.openCommitments.theirs[0].ownerPerson).toEqual(entities.get(SARAH));
    expect(s.openCommitments.theirs[0].counterparty).toEqual(entities.get(BOB));
  });

  it("uses the Organization's current workers for theirs", () => {
    const byWorker = item({ kind: 'commitment', status: 'open', ownerPersonId: SARAH });
    const byStranger = item({ kind: 'commitment', status: 'open', ownerPersonId: BOB });
    const toAcme = item({ kind: 'commitment', status: 'open', ownerPersonId: BOB, counterpartyId: ACME });
    const s = buildBriefSections(input({ items: [byWorker, byStranger, toAcme], workerIds: new Set([SARAH]) }));
    expect(s.openCommitments.theirs.map((e) => e.itemId)).toEqual([byWorker.id]);
    expect(s.openCommitments.yours.map((e) => e.itemId)).toEqual([toAcme.id]);
  });

  it('flags decisions superseded as of asOf and keeps one superseded only later', () => {
    const current = item({ kind: 'decision', subjectId: ACME, occurredAt: d('2026-09-12T00:00:00Z') });
    const laterSuperseded = item({
      kind: 'decision',
      subjectId: ACME,
      occurredAt: d('2026-09-05T00:00:00Z'),
      reviewStatus: 'superseded',
      supersededById: current.id,
      supersededByOccurredAt: d('2026-09-12T00:00:00Z'),
    });
    // As of 09-10, the older decision still stood — listed, not flagged.
    const early = buildBriefSections(input({ asOf: d('2026-09-10T00:00:00Z'), items: [current, laterSuperseded] }));
    expect(early.decisions.map((e) => [e.itemId, e.superseded])).toEqual([[laterSuperseded.id, false]]);
    // As of 09-20, it had been replaced — gone from Decisions, flagged in whatChanged.
    const late = buildBriefSections(input({ items: [current, laterSuperseded] }));
    expect(late.decisions.map((e) => e.itemId)).toEqual([current.id]);
    expect(late.whatChanged.find((e) => e.itemId === laterSuperseded.id)?.superseded).toBe(true);
  });

  it('shows windowed claims, else the newest valid ones', () => {
    const old = item({ kind: 'claim', subjectId: ACME, occurredAt: d('2026-01-01T00:00:00Z') });
    expect(buildBriefSections(input({ items: [old] })).risksClaims.map((e) => e.itemId)).toEqual([old.id]);
    const fresh = item({ kind: 'claim', subjectId: ACME, occurredAt: d('2026-09-10T00:00:00Z') });
    expect(buildBriefSections(input({ items: [old, fresh] })).risksClaims.map((e) => e.itemId)).toEqual([fresh.id]);
  });
});

describe('buildPeopleChanges', () => {
  it('reports a promotion as one ended and one started HAS_ROLE, with titles', () => {
    const at = d('2026-09-10T00:00:00Z');
    const oldRole = relation({ validFrom: d('2020-01-01T00:00:00Z'), validTo: at, props: { title: 'Engineer' } });
    const newRole = relation({ validFrom: at, props: { title: 'Staff Engineer' } });
    const changes = buildPeopleChanges(input({ relations: [newRole, oldRole] }));
    expect(changes.map((c) => [c.change, c.title, c.at])).toEqual([
      ['ended', 'Engineer', at.toISOString()],
      ['started', 'Staff Engineer', at.toISOString()],
    ]);
    expect(changes[0].person).toEqual(entities.get(SARAH));
    expect(changes[0].other).toEqual(entities.get(ACME));
  });

  it('ignores non-exclusive types, events outside the window, and unreadable ends', () => {
    const attended = relation({ type: 'ATTENDED', toId: MEETING, validFrom: d('2026-09-10T00:00:00Z') });
    const outside = relation({ validFrom: d('2025-01-01T00:00:00Z') });
    const ghost = relation({ fromId: id(777), validFrom: d('2026-09-10T00:00:00Z') });
    expect(buildPeopleChanges(input({ relations: [attended, outside, ghost] }))).toEqual([]);
  });
});

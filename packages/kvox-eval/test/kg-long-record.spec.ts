/**
 * The long-record evaluation (#780, epic #773): one invented 6,000-word record of six meetings
 * (`m60`), extracted through the product's own pipeline with a scripted model that answers with
 * the fixture's gold labels. The model call is the only thing stubbed: the context, the offered
 * schema, the validator and the deterministic rows are the ones `kg.extract` ships, so a pass
 * proves the pipeline keeps six meetings, their people and the Document, not that a model can.
 */

import { createFakeKvoxAi } from '@marinoscar/kvox-api/testing';

import type { GoldenFixture } from '../src/fixtures/fixture-schema';
import { loadGoldenSet, selectFixtures } from '../src/fixtures/load';
import { buildExtractionContext, type ProposedRow } from '../src/kg/internals';
import { fixtureToInput, precheckToPrediction, runExtraction } from '../src/kg/runners/extract-runner';
import { scoreFixture } from '../src/kg/scorer';

const [m60] = selectFixtures(loadGoldenSet(), ['m60'], null);

type Row<K extends ProposedRow['kind']> = Extract<ProposedRow, { kind: K }>;
const refOf = (ep: unknown): string => {
  const e = ep as { ref?: string; entityId?: string };
  return e.entityId ? `id:${e.entityId}` : `ref:${e.ref}`;
};

/** The model's answer if it read the record perfectly: the gold labels, in the extraction format. */
function perfectAnswer(fixture: GoldenFixture) {
  const ctx = buildExtractionContext(fixtureToInput(fixture));
  const aliasOfKnown = new Map([...ctx.knownAlias].map(([alias, id]) => [id, alias]));
  const ref = new Map<string, string>(); // gold key or known id -> model ref
  let n = 0;
  for (const e of fixture.labels.entities) {
    if (e.type === 'Document') continue; // system-created, never proposed
    ref.set(e.key, e.existingId ? aliasOfKnown.get(e.existingId)! : `e${++n}`);
  }
  const at = (key: string | null): string | null => (key === null ? null : (ref.get(key) ?? aliasOfKnown.get(key) ?? key));
  const cite = (ev: GoldenFixture['labels']['entities'][number]['evidence']) => ev.map((c) => ({ source: 'N', quote: c.quote }));
  return {
    meeting: { topics: [] },
    entities: fixture.labels.entities
      .filter((e) => e.type !== 'Document')
      .map((e) => ({ ref: ref.get(e.key)!, type: e.type, label: e.label, aliases: e.aliases, props: e.props, evidence: cite(e.evidence) })),
    relations: fixture.labels.relations.map((r) => ({
      type: r.type, from: at(r.from), to: at(r.to), props: r.props, validFrom: r.validFrom, validTo: r.validTo, precision: r.precision, evidence: cite(r.evidence),
    })),
    items: fixture.labels.items.map((i) => ({
      kind: i.kind, title: i.title, statement: i.statement, subject: at(i.subject), owner: at(i.owner), counterparty: at(i.counterparty),
      status: i.status, occurredAt: i.occurredAt, dueAt: i.dueAt, validFrom: null, validTo: null, precision: 'unknown',
      sensitivity: i.sensitivity, props: i.props, evidence: cite(i.evidence),
    })),
  };
}

async function extract(fixture: GoldenFixture) {
  const ai = createFakeKvoxAi({ script: { structured: perfectAnswer(fixture) } });
  const out = await runExtraction(ai, fixture, { model: 'stub-model' });
  if (!out) throw new Error('the stub answer failed validation');
  return out;
}

describe('the long record m60 (#780)', () => {
  it('is an invented document record: 6,000+ words, six meetings on distinct dates, two firms, about 25 people', () => {
    expect(m60.sourceType).toBe('document');
    expect(m60.hasTranscript).toBe(false);
    expect(m60.note.body.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(6000);
    const meetings = m60.labels.entities.filter((e) => e.type === 'Meeting');
    expect(meetings).toHaveLength(6);
    expect(new Set(meetings.map((m) => m.props.occurredOn)).size).toBe(6);
    expect(m60.labels.entities.filter((e) => e.type === 'Person').length).toBeGreaterThanOrEqual(25);
    expect(m60.labels.entities.filter((e) => e.type === 'Opportunity')).toHaveLength(1);
    expect(m60.labels.items.map((i) => i.kind)).toEqual(expect.arrayContaining(['commitment', 'claim', 'risk', 'decision']));
  });

  it('is offered Meeting proposals and a self entity, like any document-origin note', () => {
    const ctx = buildExtractionContext(fixtureToInput(m60));
    expect(ctx.documentOrigin).toBe(true);
    expect(ctx.offered.entityTypes.map((t) => t.key)).toContain('Meeting');
    expect(ctx.knownEntities.find((k) => k.id === m60.selfEntityId)).toBeDefined();
  });

  describe('extracted with the perfect scripted answer', () => {
    let rows: ProposedRow[];
    beforeAll(async () => {
      rows = (await extract(m60)).rows;
    });
    const entities = () => rows.filter((r): r is Row<'entity'> => r.kind === 'entity');
    const relations = (type: string) => rows.filter((r): r is Row<'relation'> => r.kind === 'relation' && r.payload.type === type);
    const refOfLabel = (label: string) => entities().find((e) => e.payload.label === label)!.payload.ref;
    const idOfKnown = (key: string) => m60.labels.entities.find((e) => e.key === key)!.existingId!;

    it('keeps at least six Meetings and no system Meeting', () => {
      const meetings = entities().filter((e) => e.payload.type === 'Meeting');
      expect(meetings.length).toBeGreaterThanOrEqual(6);
      expect(rows.some((r) => r.payload.ref === 'meeting')).toBe(false);
      expect(meetings.map((m) => (m.payload as { occurredAt: string | null }).occurredAt).sort()).toEqual(
        m60.labels.entities.filter((e) => e.type === 'Meeting').map((e) => e.props.occurredOn as string).sort(),
      );
    });

    it('links every attendee to the meeting by ATTENDED, with the attendance the record states', () => {
      const gold = m60.labels.relations.filter((r) => r.type === 'ATTENDED');
      const meetingRef = (key: string) => refOfLabel(m60.labels.entities.find((e) => e.key === key)!.label);
      const personRef = (key: string) => {
        const g = m60.labels.entities.find((e) => e.key === key)!;
        return g.existingId ? `id:${g.existingId}` : `ref:${refOfLabel(g.label)}`;
      };
      for (const g of gold) {
        const hit = relations('ATTENDED').find((r) => refOf(r.payload.from) === personRef(g.from) && refOf(r.payload.to) === `ref:${meetingRef(g.to)}`);
        expect({ attended: `${g.from}->${g.to}`, found: hit !== undefined }).toEqual({ attended: `${g.from}->${g.to}`, found: true });
        expect(hit!.payload.props).toEqual(g.props);
      }
      expect(relations('ATTENDED')).toHaveLength(gold.length);
      expect(relations('ATTENDED').filter((r) => r.payload.props.attendance === 'invited').length).toBeGreaterThanOrEqual(1);
      expect(relations('ATTENDED').filter((r) => r.payload.props.attendance === 'copied').length).toBeGreaterThanOrEqual(1);
    });

    it('gives the owner at least five edges: organizer of some meetings, attendee of all', () => {
      const self = `id:${m60.selfEntityId}`;
      const touching = rows.filter((r) => r.kind === 'relation' && (refOf(r.payload.from) === self || refOf(r.payload.to) === self));
      expect(touching.length).toBeGreaterThanOrEqual(5);
      expect(relations('ORGANIZED').filter((r) => refOf(r.payload.from) === self).length).toBeGreaterThanOrEqual(2);
      expect(relations('ATTENDED').filter((r) => refOf(r.payload.from) === self)).toHaveLength(6);
    });

    it('links every sub-unit to its parent firm by PART_OF', () => {
      const units = m60.labels.entities.filter((e) => e.type === 'Organization' && /^Org (Alpha|Beta) \w/.test(e.label));
      expect(units).toHaveLength(6);
      for (const u of units) {
        const parent = u.label.startsWith('Org Alpha') ? idOfKnown('alpha') : idOfKnown('beta');
        const hit = relations('PART_OF').find((r) => refOf(r.payload.from) === `ref:${refOfLabel(u.label)}` && refOf(r.payload.to) === `id:${parent}`);
        expect({ unit: u.label, linked: hit !== undefined }).toEqual({ unit: u.label, linked: true });
      }
    });

    it('links the opportunity to its decision makers, influencers and evaluators through INVOLVED_IN with a role', () => {
      const opp = `ref:${refOfLabel('Org Beta Product X Opportunity')}`;
      const roles = relations('INVOLVED_IN').filter((r) => refOf(r.payload.to) === opp).map((r) => r.payload.props.role);
      expect(roles.filter((r) => r === 'decision_maker')).toHaveLength(3);
      expect(roles).toEqual(expect.arrayContaining(['influencer', 'evaluator', 'account_lead']));
      for (const r of relations('INVOLVED_IN')) expect(r.payload.props.role).toEqual(expect.any(String));
    });

    it('adds the cited Document, recorded-in from each meeting and prepared for the owner', () => {
      const docs = entities().filter((e) => e.payload.type === 'Document');
      expect(docs).toHaveLength(1);
      expect(docs[0].payload.label).toBe(m60.title);
      expect(relations('RECORDED_IN').map((r) => refOf(r.payload.from)).sort()).toEqual(
        entities().filter((e) => e.payload.type === 'Meeting').map((m) => `ref:${m.payload.ref}`).sort(),
      );
      for (const r of relations('RECORDED_IN')) expect(refOf(r.payload.to)).toBe('ref:document');
      const prepared = relations('PREPARED_FOR');
      expect(prepared).toHaveLength(1);
      expect(refOf(prepared[0].payload.to)).toBe(`id:${m60.selfEntityId}`);
    });

    it('attaches each action to the meeting it was agreed in', () => {
      const meetingByDate = new Map(
        entities().filter((e) => e.payload.type === 'Meeting').map((m) => [(m.payload as { occurredAt: string }).occurredAt, m.payload.ref]),
      );
      const commitments = rows.filter((r): r is Row<'item'> => r.kind === 'item' && r.payload.kind === 'commitment');
      expect(commitments.length).toBeGreaterThanOrEqual(15);
      for (const c of commitments) {
        const gold = m60.labels.items.find((i) => i.kind === 'commitment' && i.title === c.payload.title)!;
        expect({ title: c.payload.title, meeting: refOf(c.payload.meeting) }).toEqual({
          title: c.payload.title,
          meeting: `ref:${meetingByDate.get(gold.occurredAt!)}`,
        });
      }
    });

    it('cites every row, and every row a pre-check would commit', () => {
      for (const row of rows) expect({ ref: row.payload.ref, cited: row.evidence.length > 0 }).toEqual({ ref: row.payload.ref, cited: true });
      const prediction = precheckToPrediction(m60.id, 'stub-model', rows, {});
      const committed = [...prediction.entities.filter((e) => e.resolution?.prechecked), ...prediction.relations, ...prediction.items];
      expect(committed.length).toBeGreaterThan(0);
      for (const c of committed) expect(c.evidence.length).toBeGreaterThan(0);
    });

    it('scores every labelled Meeting, attendee and organizer as found', () => {
      const prediction = precheckToPrediction(m60.id, 'stub-model', rows, {});
      const score = scoreFixture(m60, prediction);
      expect(score.types.Meeting).toEqual({ tp: 6, fp: 0, fn: 0 });
      expect(score.types['relation:ATTENDED'].fn).toBe(0);
      expect(score.types['relation:ORGANIZED']).toEqual(expect.objectContaining({ fn: 0 }));
      expect(score.evidence.valid).toBe(score.evidence.total);
    });
  });

  it('without a self entity id emits no PREPARED_FOR and still adds the Document', async () => {
    const { rows } = await extract({ ...m60, selfEntityId: null });
    expect(rows.filter((r) => r.kind === 'relation' && r.payload.type === 'PREPARED_FOR')).toHaveLength(0);
    expect(rows.filter((r) => r.kind === 'entity' && r.payload.type === 'Document')).toHaveLength(1);
  });
});

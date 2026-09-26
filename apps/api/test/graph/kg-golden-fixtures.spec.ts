/**
 * The knowledge-graph golden set is valid, and covers what it claims to
 * (issue #362, docs/specs/ontology.md §6).
 *
 * Every coverage requirement of the issue is asserted here rather than left
 * to review: a fixture edit that silently drops the only promotion, the only
 * note-only meeting or a supersedes chain fails this file.
 */

import { readdirSync, readFileSync } from 'fs';
import { basename, join, resolve } from 'path';

import { computeEffectiveSchema, validateProps } from '@app/shared/ontology';

import {
  goldenFixtureSchema,
  itemsByAddress,
  type EvidenceLabel,
  type GoldenFixture,
  type ItemLabelKind,
} from '../../scripts/kg-eval/fixture-schema';
import { GOLDEN_MEETINGS_DIR, listFixtureFiles, loadGoldenSet } from '../../scripts/kg-eval/load';
import { collapseWhitespace, quoteFoundIn } from '../../scripts/kg-eval/text';

const schema = computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] });
const fixtures = loadGoldenSet();
const byId = new Map(fixtures.map((f) => [f.id, f]));

const ITEM_TYPE: Record<ItemLabelKind, string> = {
  commitment: 'Commitment',
  decision: 'Decision',
  claim: 'Claim',
  person_fact: 'PersonFact',
};

/** Types stored in `kg_entities` (not item types), from the registry — never a hand list. */
const ENTITY_STORAGE_TYPES = schema.entityTypes.filter((t) => t.storage === 'entity').map((t) => t.key);
/** Relations a labelled edge may use: the extractable edge relations of core ∪ work. */
const LABELLED_RELATION_TYPES = schema.relationTypes.filter((r) => r.extractable).map((r) => r.key);

function allEvidence(f: GoldenFixture): EvidenceLabel[] {
  return [
    ...f.labels.entities.flatMap((e) => e.evidence),
    ...f.labels.relations.flatMap((r) => r.evidence),
    ...f.labels.items.flatMap((i) => i.evidence),
  ];
}

function freeText(f: GoldenFixture): string {
  return [
    f.title,
    f.contextText ?? '',
    f.note.body,
    ...f.segments.map((s) => s.text),
    ...f.speakers.map((s) => s.displayName ?? ''),
    ...f.labels.entities.flatMap((e) => [e.label, ...e.aliases]),
    ...f.labels.items.flatMap((i) => [i.title, i.statement]),
    ...allEvidence(f).map((e) => e.quote),
    ...f.labels.negatives.flatMap((n) => [n.quote, n.why]),
  ].join('\n');
}

/** The type a relation/item endpoint resolves to within its fixture. */
function endpointType(f: GoldenFixture, ref: string): string | undefined {
  return (
    f.labels.entities.find((e) => e.key === ref)?.type ?? f.knownEntities.find((k) => k.id === ref)?.type
  );
}

/** Canonical identity of a labelled entity: its existing id, else fixture-scoped key. */
const identity = (f: GoldenFixture, key: string) =>
  f.labels.entities.find((e) => e.key === key)?.existingId ?? `${f.id}:${key}`;

const day = (iso: string) => iso.slice(0, 10);

describe('kg golden set (issue #362)', () => {
  it('has at least 30 fixtures, each parsing against goldenFixtureSchema', () => {
    const files = listFixtureFiles(GOLDEN_MEETINGS_DIR);
    expect(files.length).toBeGreaterThanOrEqual(30);
    for (const file of files) {
      const parsed = goldenFixtureSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      expect({ file, ok: parsed.success }).toEqual({ file, ok: true });
      if (parsed.success) expect(basename(file).startsWith(`${parsed.data.id}-`)).toBe(true);
    }
  });

  it('has unique fixture ids and segment ids across the whole set', () => {
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length);
    const segIds = fixtures.flatMap((f) => f.segments.map((s) => s.id));
    expect(new Set(segIds).size).toBe(segIds.length);
    for (const f of fixtures) {
      for (const s of f.segments) expect(s.id.startsWith(`${f.id}-s`)).toBe(true);
    }
  });

  describe.each(fixtures.map((f) => [f.id, f] as const))('%s', (_id, f) => {
    it('has sorted, non-overlapping segments from declared speakers', () => {
      const speakerIds = new Set(f.speakers.map((s) => s.id));
      let prevEnd = -1;
      for (const s of f.segments) {
        expect(speakerIds.has(s.speakerId)).toBe(true);
        expect(s.endMs).toBeGreaterThan(s.startMs);
        expect(s.startMs).toBeGreaterThanOrEqual(prevEnd);
        prevEnd = s.endMs;
      }
    });

    it('is shaped like a real meeting: 20–120 segments (or note-only) and a 200–700 word note', () => {
      if (f.hasTranscript) {
        expect(f.segments.length).toBeGreaterThanOrEqual(20);
        expect(f.segments.length).toBeLessThanOrEqual(120);
      } else {
        expect(f.segments).toHaveLength(0);
        expect(f.speakers).toHaveLength(0);
        for (const ev of allEvidence(f)) expect(ev.source).toBe('note');
      }
      const words = f.note.body.split(/\s+/).filter(Boolean).length;
      expect(words).toBeGreaterThanOrEqual(200);
      expect(words).toBeLessThanOrEqual(700);
    });

    it('cites only evidence that resolves: every segment exists and every quote is found verbatim', () => {
      for (const ev of allEvidence(f)) {
        if (ev.source === 'segment') {
          const seg = f.segments.find((s) => s.id === ev.segmentId);
          expect({ segmentId: ev.segmentId, exists: seg !== undefined }).toEqual({
            segmentId: ev.segmentId,
            exists: true,
          });
          expect({ quote: ev.quote, found: seg ? quoteFoundIn(ev.quote, seg.text) : false }).toEqual({
            quote: ev.quote,
            found: true,
          });
        } else {
          expect({ quote: ev.quote, found: quoteFoundIn(ev.quote, f.note.body) }).toEqual({
            quote: ev.quote,
            found: true,
          });
        }
      }
    });

    it('labels only real ontology types, with props the ontology accepts', () => {
      const keys = f.labels.entities.map((e) => e.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const e of f.labels.entities) {
        expect(ENTITY_STORAGE_TYPES).toContain(e.type);
        expect(validateProps(schema, e.type, e.props).ok).toBe(true);
      }
      for (const k of f.knownEntities) expect(ENTITY_STORAGE_TYPES).toContain(k.type);
      for (const r of f.labels.relations) {
        expect(LABELLED_RELATION_TYPES).toContain(r.type);
        expect({ type: r.type, props: validateProps(schema, r.type, r.props, { relation: true }).ok }).toEqual({
          type: r.type,
          props: true,
        });
        // The write-purpose validator accepts a partial object; a label must be complete.
        for (const p of schema.relationType(r.type)!.props.filter((a) => a.required)) {
          expect({ type: r.type, prop: p.key, present: r.props[p.key] !== undefined }).toEqual({
            type: r.type,
            prop: p.key,
            present: true,
          });
        }
      }
    });

    it('resolves every reference, and every relation endpoint satisfies its from/to lists', () => {
      const knownIds = new Set(f.knownEntities.map((k) => k.id));
      for (const e of f.labels.entities) {
        if (e.existingId !== null) {
          expect(knownIds.has(e.existingId)).toBe(true);
          expect(f.knownEntities.find((k) => k.id === e.existingId)?.type).toBe(e.type);
        }
      }
      for (const r of f.labels.relations) {
        const spec = schema.relationType(r.type)!;
        const from = endpointType(f, r.from);
        const to = endpointType(f, r.to);
        expect({ rel: `${r.type} ${r.from}->${r.to}`, from, to }).toEqual({
          rel: `${r.type} ${r.from}->${r.to}`,
          from: expect.any(String),
          to: expect.any(String),
        });
        expect(spec.from).toContain(from);
        expect(spec.to).toContain(to);
        if (spec.allowedPairs) {
          expect(spec.allowedPairs.some(([a, b]) => a === from && b === to)).toBe(true);
        }
      }
      const assignedTo = schema.relationType('ASSIGNED_TO')!.to;
      const owedTo = schema.relationType('OWED_TO')!.to;
      for (const i of f.labels.items) {
        const itemType = schema.entityType(ITEM_TYPE[i.kind])!;
        expect(itemType.subjectTypes).toContain(endpointType(f, i.subject));
        if (i.owner !== null) expect(assignedTo).toContain(endpointType(f, i.owner));
        if (i.counterparty !== null) expect(owedTo).toContain(endpointType(f, i.counterparty));
      }
    });

    it('states time the §5.4 way', () => {
      for (const r of f.labels.relations) {
        const temporal = schema.relationType(r.type)!.temporal;
        const where = `${r.type} ${r.from}->${r.to}`;
        if (!temporal || r.precision === 'unknown') {
          expect({ where, validFrom: r.validFrom, validTo: r.validTo }).toEqual({ where, validFrom: null, validTo: null });
          if (!temporal) expect(r.precision).toBe('unknown');
          continue;
        }
        expect(r.validFrom !== null || r.validTo !== null).toBe(true);
        for (const d of [r.validFrom, r.validTo]) {
          if (d === null) continue;
          if (r.precision === 'month') expect(d.endsWith('-01')).toBe(true);
          if (r.precision === 'year') expect(d.endsWith('-01-01')).toBe(true);
        }
        if (r.validFrom && r.validTo) expect(r.validTo > r.validFrom).toBe(true);
      }
      for (const i of f.labels.items) {
        expect(i.status !== null).toBe(i.kind === 'commitment');
        expect(i.sensitivity !== null).toBe(i.kind === 'person_fact');
        if (i.dueAt && i.occurredAt) expect(i.dueAt >= i.occurredAt).toBe(true);
      }
    });

    it('supersedes only an earlier item of the same kind', () => {
      for (const i of f.labels.items) {
        if (i.supersedesLabel === null) continue;
        const [targetId] = i.supersedesLabel.split('#');
        const target = byId.get(targetId);
        expect(target).toBeDefined();
        expect(itemsByAddress(target!).get(i.supersedesLabel)?.kind).toBe(i.kind);
        expect(target!.recordedAt < f.recordedAt).toBe(true);
      }
    });

    it('records prior attendance only of earlier fixtures', () => {
      for (const k of f.knownEntities) {
        for (const id of k.attendedFixtureIds) {
          expect(byId.has(id)).toBe(true);
          expect(byId.get(id)!.recordedAt < f.recordedAt).toBe(true);
        }
      }
    });

    it('locates every negative example in the source text', () => {
      const all = `${f.note.body}\n${f.segments.map((s) => s.text).join('\n')}`;
      for (const n of f.labels.negatives) {
        expect({ quote: n.quote, found: collapseWhitespace(all).includes(collapseWhitespace(n.quote)) }).toEqual({
          quote: n.quote,
          found: true,
        });
      }
    });

    it('contains no real contact details and no product name', () => {
      const text = freeText(f);
      expect(text).not.toMatch(/[\w.+-]+@(?!example\.com)[\w-]+\.\w+/);
      expect(text).not.toMatch(/\+?\d[\d\s().-]{8,}\d/);
      const identity = JSON.parse(
        readFileSync(resolve(__dirname, '../../../../packages/shared/identity.json'), 'utf8'),
      ) as { productName: string };
      expect(JSON.stringify(f).toLowerCase()).not.toContain(identity.productName.toLowerCase());
    });
  });

  describe('coverage (the issue\'s list, asserted — not reviewed)', () => {
    const entities = fixtures.flatMap((f) => f.labels.entities.map((e) => ({ f, e })));
    const relations = fixtures.flatMap((f) => f.labels.relations.map((r) => ({ f, r })));
    const items = fixtures.flatMap((f) => f.labels.items.map((i) => ({ f, i })));
    const tagged = (tag: string) => fixtures.filter((f) => f.tags.includes(tag));

    it('has ≥ 10 gold instances of every core + work entity-storage type', () => {
      expect(ENTITY_STORAGE_TYPES.sort()).toEqual(['Meeting', 'Organization', 'Person', 'Project']);
      for (const t of ENTITY_STORAGE_TYPES) {
        expect({ t, n: entities.filter(({ e }) => e.type === t).length >= 10 }).toEqual({ t, n: true });
      }
    });

    it('has ≥ 15 of each item kind', () => {
      for (const kind of Object.keys(ITEM_TYPE)) {
        expect({ kind, n: items.filter(({ i }) => i.kind === kind).length >= 15 }).toEqual({ kind, n: true });
      }
    });

    it('has ≥ 3 of every extractable relation type, and ≥ 3 of each item-column relation', () => {
      // Every relation except IDENTIFIED_AS, MENTIONS and SUPPORTED_BY: the six
      // edge relations as labels, the item-column ones as item fields.
      for (const t of LABELLED_RELATION_TYPES) {
        expect({ t, n: relations.filter(({ r }) => r.type === t).length >= 3 }).toEqual({ t, n: true });
      }
      const columnRelations = {
        ABOUT: items.filter(({ i }) => i.subject).length,
        ASSIGNED_TO: items.filter(({ i }) => i.owner).length,
        OWED_TO: items.filter(({ i }) => i.counterparty).length,
        SUPERSEDES: items.filter(({ i }) => i.supersedesLabel).length,
        CREATED_IN: items.filter(({ i }) => i.kind === 'commitment').length,
        DECIDED_IN: items.filter(({ i }) => i.kind === 'decision').length,
      };
      for (const [t, n] of Object.entries(columnRelations)) expect({ t, ok: n >= 3 }).toEqual({ t, ok: true });
    });

    it('has ≥ 10 labels that must link to an existing entity', () => {
      expect(entities.filter(({ e }) => e.existingId !== null).length).toBeGreaterThanOrEqual(10);
    });

    it('has ≥ 3 unknown-precision temporal facts and an "in 2026" year-precision fact', () => {
      const temporal = relations.filter(({ r }) => schema.relationType(r.type)!.temporal);
      expect(temporal.filter(({ r }) => r.precision === 'unknown').length).toBeGreaterThanOrEqual(3);
      expect(
        temporal.some(({ r }) => r.precision === 'year' && r.validFrom === '2026-01-01'),
      ).toBe(true);
    });

    it('covers a promotion and a manager change as dated edges', () => {
      expect(tagged('promotion').length).toBeGreaterThanOrEqual(1);
      for (const f of tagged('promotion')) {
        expect(f.labels.relations.some((r) => r.type === 'HAS_ROLE' && r.validFrom !== null)).toBe(true);
      }
      expect(tagged('manager-change').length).toBeGreaterThanOrEqual(1);
      for (const f of tagged('manager-change')) {
        expect(f.labels.relations.some((r) => r.type === 'REPORTS_TO' && r.validFrom !== null)).toBe(true);
      }
    });

    it('covers a company change with an open commitment owned by the leaver', () => {
      const f = tagged('company-change');
      expect(f.length).toBeGreaterThanOrEqual(1);
      for (const fx of f) {
        const closed = fx.labels.relations.filter((r) => r.type === 'WORKS_FOR' && r.validTo !== null);
        const leaver = closed.find((c) =>
          fx.labels.relations.some(
            (r) => r.type === 'WORKS_FOR' && r.from === c.from && r.to !== c.to && r.validFrom !== null,
          ),
        );
        expect(leaver).toBeDefined();
        expect(
          fx.labels.items.some((i) => i.kind === 'commitment' && i.owner === leaver!.from && i.status === 'open'),
        ).toBe(true);
      }
    });

    it('covers an out-of-order meeting: a 2020 recording arriving after 2026 ones', () => {
      const f = tagged('out-of-order');
      expect(f.length).toBeGreaterThanOrEqual(1);
      for (const fx of f) {
        expect(fx.recordedAt.startsWith('2020-')).toBe(true);
        expect(fixtures.some((o) => o.id < fx.id && o.recordedAt > fx.recordedAt)).toBe(true);
      }
    });

    it('resolves relative dates against recordedAt', () => {
      const f = tagged('relative-date');
      expect(f.length).toBeGreaterThanOrEqual(3);
      const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      let nextWeekday = 0;
      let inWeeks = 0;
      for (const fx of f) {
        const recorded = day(fx.recordedAt);
        const relative = fx.labels.items.filter((i) =>
          i.evidence.some((e) => /next (monday|tuesday|wednesday|thursday|friday)|in (two|three|four) weeks|by (monday|tuesday|wednesday|thursday|friday)\b/i.test(e.quote)),
        );
        expect({ id: fx.id, n: relative.length > 0 }).toEqual({ id: fx.id, n: true });
        for (const i of relative) {
          expect(i.dueAt).not.toBeNull();
          expect(i.dueAt! > recorded).toBe(true);
          const quote = i.evidence.map((e) => e.quote).join(' ').toLowerCase();
          const weekday = /next (monday|tuesday|wednesday|thursday|friday)/.exec(quote);
          if (weekday) {
            nextWeekday += 1;
            expect(WEEKDAYS[new Date(`${i.dueAt}T00:00:00Z`).getUTCDay()]).toBe(weekday[1]);
          }
          const weeks = /in (two|three|four) weeks/.exec(quote);
          if (weeks) {
            inWeeks += 1;
            const n = { two: 14, three: 21, four: 28 }[weeks[1] as 'two' | 'three' | 'four'];
            const expected = new Date(`${recorded}T00:00:00Z`);
            expected.setUTCDate(expected.getUTCDate() + n);
            expect(i.dueAt).toBe(expected.toISOString().slice(0, 10));
          }
        }
      }
      expect(nextWeekday).toBeGreaterThanOrEqual(1);
      expect(inWeeks).toBeGreaterThanOrEqual(1);
    });

    it('carries every §5.1 negative, each labelled', () => {
      for (const tag of [
        'negative-role',
        'negative-on-call',
        'negative-passing-team',
        'negative-topic',
        'negative-vague-task',
      ]) {
        const f = tagged(tag);
        expect({ tag, n: f.length > 0 }).toEqual({ tag, n: true });
        for (const fx of f) expect({ tag, id: fx.id, n: fx.labels.negatives.length > 0 }).toEqual({ tag, id: fx.id, n: true });
      }
      const quotes = fixtures.flatMap((f) => f.labels.negatives.map((n) => n.quote.toLowerCase()));
      expect(quotes.some((q) => q.includes('the cio'))).toBe(true);
      expect(quotes.some((q) => q.includes("whoever's on call") || q.includes('whoever was on call'))).toBe(true);
      expect(quotes.some((q) => q.includes('data team'))).toBe(true);
      expect(quotes.some((q) => q.includes('ai code review'))).toBe(true);
      expect(quotes.some((q) => q.includes('we should probably look into'))).toBe(true);
    });

    it('has PersonFacts at all three sensitivity levels, ≥ 3 sensitive', () => {
      const facts = items.filter(({ i }) => i.kind === 'person_fact');
      expect(facts.filter(({ i }) => i.sensitivity === 'business').length).toBeGreaterThanOrEqual(1);
      expect(facts.filter(({ i }) => i.sensitivity === 'personal').length).toBeGreaterThanOrEqual(1);
      expect(facts.filter(({ i }) => i.sensitivity === 'sensitive').length).toBeGreaterThanOrEqual(3);
    });

    it('sets the resolution traps', () => {
      // Two different people named Sarah at different organizations, both in one fixture's prior graph.
      const sarahs = new Set(
        entities.filter(({ e }) => e.type === 'Person' && /^Sarah\b/.test(e.label)).map(({ f, e }) => identity(f, e.key)),
      );
      expect(sarahs.size).toBeGreaterThanOrEqual(2);
      expect(
        fixtures.some(
          (f) => f.knownEntities.filter((k) => k.type === 'Person' && /^Sarah\b/.test(k.label)).length >= 2,
        ),
      ).toBe(true);

      const citesLinked = (existingId: string, re: RegExp) =>
        entities.some(({ e }) => e.existingId === existingId && e.evidence.some((ev) => re.test(ev.quote)));
      // A misspelling ("Sara Chen") that must still link to Sarah Chen.
      expect(citesLinked('g-person-sarah-chen', /\bSara Chen\b/)).toBe(true);
      // A nickname ("JJ") that matches a known alias.
      expect(
        fixtures.some((f) => f.knownEntities.some((k) => k.id === 'g-person-jonah-jimenez' && k.aliases.includes('JJ'))),
      ).toBe(true);
      expect(citesLinked('g-person-jonah-jimenez', /\bJJ\b/)).toBe(true);
      // An organization abbreviation ("NWR" / "Northwind Robotics").
      expect(citesLinked('g-org-northwind-robotics', /\bNWR\b/)).toBe(true);
    });

    it('has supersedes chains: a decision reversed later, and "moved to Q2" after "in Q1"', () => {
      const chains = items.filter(({ i }) => i.supersedesLabel !== null);
      expect(chains.some(({ i }) => i.kind === 'decision')).toBe(true);
      const q2 = chains.find(({ i }) => i.kind === 'claim' && /moved to Q2/.test(i.statement));
      expect(q2).toBeDefined();
      const [targetId] = q2!.i.supersedesLabel!.split('#');
      expect(itemsByAddress(byId.get(targetId)!).get(q2!.i.supersedesLabel!)?.statement).toMatch(/Q1/);
    });

    it('has ≥ 2 note-only meetings', () => {
      expect(fixtures.filter((f) => !f.hasTranscript).length).toBeGreaterThanOrEqual(2);
    });
  });

  it('ships no stray files in the meetings directory', () => {
    const stray = readdirSync(GOLDEN_MEETINGS_DIR).filter((f) => !f.endsWith('.json'));
    expect(stray).toEqual([]);
    expect(join(GOLDEN_MEETINGS_DIR)).toContain(join('test', 'fixtures', 'kg-golden', 'meetings'));
  });
});

/**
 * The kg:eval scorer (issue #362): pure matching rules, pinned case by case.
 */

import { goldenFixtureSchema, type GoldenFixture, type GoldenFixtureInput } from '../../scripts/kg-eval/fixture-schema';
import { goldPrediction } from '../../scripts/kg-eval/gold-runner';
import { loadGoldenSet } from '../../scripts/kg-eval/load';
import type { KgEvalPrediction } from '../../scripts/kg-eval/prediction-schema';
import { buildReport, formatReport, kgEvalReportSchema } from '../../scripts/kg-eval/report';
import {
  autoLinkPrecision,
  commitmentRecall,
  entityCoverage,
  normalizeName,
  recallOf,
  scoreFixture,
  scoreRun,
  temporalEqual,
} from '../../scripts/kg-eval/scorer';

const seg = (id: string, text: string, startMs: number) => ({
  id,
  speakerId: 'spk-a',
  startMs,
  endMs: startMs + 1000,
  text,
});

/** A small, hand-built fixture: one meeting, three people, one commitment, one temporal edge. */
function tinyFixture(overrides: Partial<GoldenFixtureInput['labels']> = {}): GoldenFixture {
  const input: GoldenFixtureInput = {
    id: 'm99',
    title: 'Tiny meeting',
    tags: [],
    recordedAt: '2026-03-05T10:00:00Z',
    contextText: null,
    hasTranscript: true,
    speakers: [{ id: 'spk-a', label: 'A', displayName: 'Alex Rivera' }],
    segments: [
      seg('m99-s001', 'JJ will send the draft plan to Sarah Chen by Friday.', 0),
      seg('m99-s002', 'Sarah Chen joined Northwind Robotics in 2026.', 1100),
      seg('m99-s003', 'Priya Raman runs the team.', 2200),
    ],
    note: { version: 1, body: '# Tiny meeting\n\nJJ owes Sarah the draft plan.' },
    knownEntities: [
      { id: 'g-jj', type: 'Person', label: 'Jonah Jiménez', aliases: ['JJ'], props: {}, attendedFixtureIds: [] },
      { id: 'g-sarah', type: 'Person', label: 'Sarah Chen', aliases: [], props: {}, attendedFixtureIds: [] },
      { id: 'g-priya', type: 'Person', label: 'Priya Raman', aliases: [], props: {}, attendedFixtureIds: [] },
      { id: 'g-nwr', type: 'Organization', label: 'Northwind Robotics', aliases: ['NWR'], props: {}, attendedFixtureIds: [] },
    ],
    labels: {
      entities: [
        {
          key: 'jj',
          type: 'Person',
          label: 'Jonah Jiménez',
          aliases: ['JJ'],
          existingId: 'g-jj',
          evidence: [{ source: 'segment', segmentId: 'm99-s001', quote: 'JJ will send' }],
        },
        {
          key: 'sarah',
          type: 'Person',
          label: 'Sarah Chen',
          existingId: 'g-sarah',
          evidence: [{ source: 'segment', segmentId: 'm99-s002', quote: 'Sarah Chen joined' }],
        },
        {
          key: 'priya',
          type: 'Person',
          label: 'Priya Raman',
          existingId: 'g-priya',
          evidence: [{ source: 'segment', segmentId: 'm99-s003', quote: 'Priya Raman runs the team.' }],
        },
        {
          key: 'nwr',
          type: 'Organization',
          label: 'Northwind Robotics',
          aliases: ['NWR'],
          existingId: 'g-nwr',
          evidence: [{ source: 'segment', segmentId: 'm99-s002', quote: 'Northwind Robotics' }],
        },
      ],
      relations: [
        {
          type: 'WORKS_FOR',
          from: 'sarah',
          to: 'nwr',
          validFrom: '2026-01-01',
          validTo: null,
          precision: 'year',
          evidence: [{ source: 'segment', segmentId: 'm99-s002', quote: 'joined Northwind Robotics in 2026' }],
        },
      ],
      items: [
        {
          kind: 'commitment',
          subject: 'sarah',
          owner: 'jj',
          counterparty: 'sarah',
          title: 'Send the draft plan',
          statement: 'JJ will send the draft plan to Sarah Chen by Friday.',
          status: 'open',
          occurredAt: '2026-03-05',
          dueAt: '2026-03-06',
          evidence: [{ source: 'segment', segmentId: 'm99-s001', quote: 'JJ will send the draft plan' }],
        },
      ],
      negatives: [],
      ...overrides,
    },
  };
  return goldenFixtureSchema.parse(input);
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('normalizeName', () => {
  it.each([
    ['Sarah Chen', 'sarah chen'],
    ['  Sarah   Chen, ', 'sarah chen'],
    ['SARAH CHEN.', 'sarah chen'],
    ["O'Neil-Smith", "o'neil-smith"],
    ["'quoted'", 'quoted'],
    ['- dash -', 'dash'],
    ['Tomás Aguilar', 'tomás aguilar'],
    ['Ｆｕｌｌｗｉｄｔｈ', 'fullwidth'],
    ['Dr. Haddad', 'dr haddad'],
    ['Northwind Robotics (NWR)', 'northwind robotics nwr'],
    ['Sarah’s', "sarah's"],
  ])('%j → %j', (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });
});

describe('scoreFixture / scoreRun', () => {
  it('scores gold against gold as 1.0 everywhere, over the whole committed set', () => {
    const fixtures = loadGoldenSet();
    const preds = new Map(fixtures.map((f) => [f.id, goldPrediction(f)]));
    const report = buildReport(scoreRun(fixtures, preds), {
      runner: 'gold',
      model: null,
      fixtureIds: fixtures.map((f) => f.id),
    });
    expect(kgEvalReportSchema.parse(report)).toEqual(report);
    for (const t of report.types) {
      expect({ type: t.type, p: t.precision, r: t.recall }).toEqual({ type: t.type, p: 1, r: 1 });
    }
    expect(report.metrics.entityCoverage.value).toBe(1);
    expect(report.metrics.commitmentRecall.value).toBe(1);
    expect(report.metrics.autoLinkPrecision.value).toBe(1);
    expect(report.metrics.evidenceValidity.value).toBe(1);
    expect(report.metrics.temporalAccuracy.value).toBe(1);
    expect(report.targetsMet).toBe(true);
    expect(formatReport(report)).toMatch(/^kg:eval {2}fixtures=\d+ {2}runner=gold {2}model=-/);
  });

  it('lowers Commitment recall to (n-1)/n for one missed commitment', () => {
    const fixtures = loadGoldenSet();
    const preds = new Map(fixtures.map((f) => [f.id, goldPrediction(f)]));
    const n = fixtures.reduce((a, f) => a + f.labels.items.filter((i) => i.kind === 'commitment').length, 0);
    const first = fixtures.find((f) => f.labels.items.some((i) => i.kind === 'commitment'))!;
    const pred = preds.get(first.id)!;
    pred.items.splice(
      pred.items.findIndex((i) => i.kind === 'commitment'),
      1,
    );
    const run = scoreRun(fixtures, preds);
    expect(commitmentRecall(run)).toBeCloseTo((n - 1) / n, 10);
    expect(run.types.Commitment).toEqual({ tp: n - 1, fp: 0, fn: 1 });
  });

  it('counts a wrong type as one FP (predicted type) and one FN (gold type)', () => {
    const f = tinyFixture();
    const pred = goldPrediction(f);
    pred.entities.find((e) => e.ref === 'priya')!.type = 'Organization';
    const s = scoreFixture(f, pred);
    expect(s.types.Person).toEqual({ tp: 2, fp: 0, fn: 1 });
    expect(s.types.Organization).toEqual({ tp: 1, fp: 1, fn: 0 });
    // Coverage ignores type: Priya is still "found".
    expect(s.coverage).toEqual({ matched: 4, total: 4 });
  });

  it('matches an alias ("JJ") as a true positive', () => {
    const f = tinyFixture();
    const pred = goldPrediction(f);
    const jj = pred.entities.find((e) => e.ref === 'jj')!;
    jj.label = 'JJ';
    jj.aliases = [];
    expect(scoreFixture(f, pred).types.Person).toEqual({ tp: 3, fp: 0, fn: 0 });
  });

  it('assigns one-to-one: two predicted Sarahs against one gold Sarah is 1 TP + 1 FP', () => {
    const f = tinyFixture();
    const pred = goldPrediction(f);
    pred.entities.push({ ...clone(pred.entities.find((e) => e.ref === 'sarah')!), ref: 'sarah-2', resolution: null });
    const s = scoreFixture(f, pred);
    expect(s.types.Person).toEqual({ tp: 3, fp: 1, fn: 0 });
  });

  it('does not match below token-set Jaccard 0.8, but does at or above it', () => {
    const f = tinyFixture();
    const low = goldPrediction(f);
    low.entities.find((e) => e.ref === 'priya')!.label = 'Priya';
    expect(scoreFixture(f, low).types.Person).toEqual({ tp: 2, fp: 1, fn: 1 });

    const reordered = goldPrediction(f);
    reordered.entities.find((e) => e.ref === 'priya')!.label = 'Raman, Priya';
    expect(scoreFixture(f, reordered).types.Person).toEqual({ tp: 3, fp: 0, fn: 0 });
  });

  it('treats a statement with token-set F1 < 0.5 as an FN (and the prediction as an FP)', () => {
    const f = tinyFixture();
    const pred = goldPrediction(f);
    pred.items[0].statement = 'Budget review happens next quarter.';
    expect(scoreFixture(f, pred).types.Commitment).toEqual({ tp: 0, fp: 1, fn: 1 });
  });

  it('requires a commitment owner to match when the label names one', () => {
    const f = tinyFixture();
    const pred = goldPrediction(f);
    pred.items[0].owner = 'priya';
    expect(scoreFixture(f, pred).types.Commitment).toEqual({ tp: 0, fp: 1, fn: 1 });
  });

  it('accepts a relation endpoint named by knownEntities id instead of a ref', () => {
    const f = tinyFixture();
    const pred = goldPrediction(f);
    pred.relations[0].from = 'g-sarah';
    pred.relations[0].to = 'g-nwr';
    expect(scoreFixture(f, pred).types['relation:WORKS_FOR']).toEqual({ tp: 1, fp: 0, fn: 0 });
  });

  it('computes auto-link precision over prechecked links only: 3 links, 1 wrong → 0.667', () => {
    const f = tinyFixture();
    const pred = goldPrediction(f);
    // jj, sarah, priya prechecked-linked; one wrong; the org link is not prechecked.
    pred.entities.find((e) => e.ref === 'priya')!.resolution = {
      outcome: 'linked',
      entityId: 'g-sarah',
      score: 0.97,
      prechecked: true,
    };
    pred.entities.find((e) => e.ref === 'nwr')!.resolution = {
      outcome: 'linked',
      entityId: 'g-nwr',
      score: 0.8,
      prechecked: false,
    };
    const run = scoreRun([f], new Map([[f.id, pred]]));
    expect(autoLinkPrecision(run)).toBeCloseTo(2 / 3, 10);
    expect(buildReport(run, { runner: 'x', model: null, fixtureIds: [f.id] }).metrics.autoLinkPrecision.value).toBeCloseTo(0.667, 3);
  });

  it('reports auto-link precision as n/a when no prediction carries a resolution', () => {
    const f = tinyFixture();
    const pred = goldPrediction(f);
    for (const e of pred.entities) e.resolution = null;
    const run = scoreRun([f], new Map([[f.id, pred]]));
    expect(autoLinkPrecision(run)).toBeNull();
    const report = buildReport(run, { runner: 'x', model: null, fixtureIds: [f.id] });
    expect(report.metrics.autoLinkPrecision.pass).toBeNull();
    expect(formatReport(report)).toMatch(/AUTO-LINK PRECISION\s+n\/a\s+target ≥ 0\.95\s+\(no resolution in predictions\)/);
  });

  it('counts a year-vs-day precision mismatch as temporally inaccurate', () => {
    const f = tinyFixture();
    const pred = goldPrediction(f);
    pred.relations[0].precision = 'day';
    const s = scoreFixture(f, pred);
    expect(s.types['relation:WORKS_FOR']).toEqual({ tp: 1, fp: 0, fn: 0 });
    // One temporal relation (inaccurate) + one dated item (accurate).
    expect(s.temporal).toEqual({ accurate: 1, total: 2 });
  });

  it('compares dates only at the gold precision, and unknown only to unknown', () => {
    const gold = { validFrom: '2026-01-01', validTo: null, precision: 'year' as const };
    expect(temporalEqual(gold, { validFrom: '2026-06-15', validTo: null, precision: 'year' })).toBe(true);
    expect(temporalEqual(gold, { validFrom: '2025-01-01', validTo: null, precision: 'year' })).toBe(false);
    const month = { validFrom: '2026-03-01', validTo: '2026-04-01', precision: 'month' as const };
    expect(temporalEqual(month, { validFrom: '2026-03-31', validTo: '2026-04-15', precision: 'month' })).toBe(true);
    const unknown = { validFrom: null, validTo: null, precision: 'unknown' as const };
    expect(temporalEqual(unknown, { validFrom: null, validTo: null, precision: 'unknown' })).toBe(true);
    expect(temporalEqual(unknown, { validFrom: '2026-01-01', validTo: null, precision: 'year' })).toBe(false);
  });

  it('counts evidence that does not resolve, or whose quote is not located, as invalid', () => {
    const f = tinyFixture();
    const pred = goldPrediction(f);
    pred.entities[0].evidence.push({ source: 'segment', segmentId: 'm99-s404', quote: 'JJ will send' });
    pred.entities[1].evidence.push({ source: 'segment', segmentId: 'm99-s001', quote: 'not in the segment' });
    pred.entities[2].evidence.push({ source: 'note', segmentId: null, quote: 'JJ owes   Sarah' });
    const s = scoreFixture(f, pred);
    const total = s.evidence.total;
    expect(s.evidence).toEqual({ valid: total - 2, total });
  });

  it('scores a missing prediction as empty: everything gold is a false negative', () => {
    const f = tinyFixture();
    const run = scoreRun([f], new Map<string, KgEvalPrediction>());
    expect(entityCoverage(run)).toBe(0);
    expect(recallOf(run.types.Person)).toBe(0);
    expect(run.types['relation:WORKS_FOR']).toEqual({ tp: 0, fp: 0, fn: 1 });
    expect(buildReport(run, { runner: 'x', model: null, fixtureIds: [f.id] }).targetsMet).toBe(false);
  });

  it('aggregates stats passthrough into the DROPPED line', () => {
    const f = tinyFixture();
    const pred = { ...goldPrediction(f), stats: { uncited: 3, invalid: 1, unknownType: 2 } };
    const report = buildReport(scoreRun([f], new Map([[f.id, pred]])), {
      runner: 'x',
      model: 'm',
      fixtureIds: [f.id],
    });
    expect(report.dropped).toEqual({ uncited: 3, invalid: 1, unknownType: 2 });
    expect(formatReport(report)).toContain('DROPPED (stats)      uncited=3 invalid=1 unknownType=2');
  });
});

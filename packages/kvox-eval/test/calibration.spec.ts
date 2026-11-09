/**
 * The graph embedding calibration harness (issue #681): the labelled set, the metrics, the
 * recommendation rules, the headroom derivation the catalog's bge numbers come from, the replay
 * of the product's own decisions, and the `kvox-eval calibrate` command. Runs on deterministic
 * hashed n-gram vectors and recorded-vector files: no network, no model, no key.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { KVOX_EMBEDDING, KVOX_LOCAL_EMBEDDING } from '@marinoscar/kvox-ai';

import { main } from '../src/cli/main';
import type { EvalCommandIo } from '../src/cli/kg-command';
import { buildCalibrationSet, calibrationTexts, loadHandPairs } from '../src/calibration/calibration-set';
import { hashedNgramVectors } from '../src/calibration/embedders';
import { evaluateModel, recommendedCalibration } from '../src/calibration/evaluate';
import {
  cosine,
  highestThresholdWithRecall,
  lowestThresholdWithPrecision,
  mapCutoffByHeadroom,
  pgTrigramSimilarity,
  sweep,
} from '../src/calibration/metrics';
import { loadGoldenMeetings } from '../src/fixtures/load';
import { DEFAULT_GRAPH_CALIBRATION } from '../src/calibration/internals';

const OPENAI = { ...DEFAULT_GRAPH_CALIBRATION };
const BGE = KVOX_LOCAL_EMBEDDING.graphCalibration!;

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: EvalCommandIo = { out: (s) => out.push(s), err: (s) => err.push(s), env: {} };
  return { io, out, err };
}

describe('metrics', () => {
  it('computes cosine', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([], [1])).toBe(0);
  });

  it("matches pg_trgm's documented similarity", () => {
    expect(pgTrigramSimilarity('word', 'two words')).toBeCloseTo(0.363636, 5);
    expect(pgTrigramSimilarity('Sasha Example', 'sasha example')).toBe(1);
    expect(pgTrigramSimilarity('', 'x')).toBe(0);
  });

  const samples = [
    { score: 0.95, positive: true },
    { score: 0.9, positive: true },
    { score: 0.85, positive: false },
    { score: 0.8, positive: true },
    { score: 0.6, positive: false },
  ];

  it('sweeps precision and recall per threshold', () => {
    const points = sweep(samples, [0.5, 0.82, 0.9, 0.99]);
    expect(points.map((p) => [p.tp, p.fp, p.fn, p.tn])).toEqual([
      [3, 2, 0, 0],
      [2, 1, 1, 1],
      [2, 0, 1, 2],
      [0, 0, 3, 2],
    ]);
    expect(points[2].precision).toBe(1);
    expect(points[2].recall).toBeCloseTo(2 / 3, 6);
    expect(points[3].precision).toBeNull();
  });

  it('recommends the lowest precise threshold and the highest threshold that keeps recall', () => {
    const points = sweep(samples, [0.5, 0.82, 0.9, 0.99]);
    expect(lowestThresholdWithPrecision(points, 0.95)).toBe(0.9);
    expect(lowestThresholdWithPrecision(points, 0.5)).toBe(0.5);
    expect(highestThresholdWithRecall(points, 1)).toBe(0.5);
    expect(highestThresholdWithRecall(points, 0.6)).toBe(0.9);
    expect(lowestThresholdWithPrecision(sweep([{ score: 0.9, positive: false }], [0.5]), 0.5)).toBeNull();
  });

  it("derives the catalog's bge cut-offs from the OpenAI ones by headroom above the unrelated ceiling", () => {
    // OpenAI text-embedding-3-small unrelated pairs top out near 0.35; bge-small-en-v1.5's at 0.55 (search baseline).
    const ceilings = { from: 0.35, to: 0.55 };
    expect(mapCutoffByHeadroom(OPENAI.vectorFloor, ceilings)).toBe(BGE.vectorFloor);
    expect(mapCutoffByHeadroom(OPENAI.itemCosine, ceilings)).toBe(BGE.itemCosine);
    expect(mapCutoffByHeadroom(OPENAI.itemSameConfidentCosine, ceilings)).toBe(BGE.itemSameConfidentCosine);
    expect(mapCutoffByHeadroom(0.8, { from: 0.35, to: 0.35 })).toBe(0.8);
  });
});

describe('the calibration set', () => {
  const fixtures = loadGoldenMeetings();
  const set = buildCalibrationSet(fixtures);

  it('is deterministic', () => {
    expect(buildCalibrationSet(fixtures)).toEqual(set);
    expect(calibrationTexts(set)).toEqual(calibrationTexts(set));
  });

  it('holds enough positives and negatives of every kind to measure on', () => {
    const count = (f: (p: (typeof set.entityPairs)[number]) => boolean) => set.entityPairs.filter(f).length;
    expect(count((p) => p.same && p.origin === 'golden-alias')).toBeGreaterThanOrEqual(5);
    expect(count((p) => !p.same && p.origin === 'golden-distinct')).toBeGreaterThanOrEqual(50);
    expect(count((p) => p.origin === 'hand')).toBe(loadHandPairs().entityPairs.length);
    expect(set.itemPairs.filter((p) => p.duplicate).length).toBeGreaterThanOrEqual(15);
    expect(set.itemPairs.filter((p) => !p.duplicate).length).toBeGreaterThanOrEqual(50);
  });

  it('has unique ids and never labels a pair of one text as distinct', () => {
    const ids = [...set.entityPairs, ...set.itemPairs].map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(set.entityPairs.filter((p) => !p.same).every((p) => p.a.toLowerCase() !== p.b.toLowerCase())).toBe(true);
    expect(set.itemPairs.filter((p) => !p.duplicate).every((p) => p.a !== p.b)).toBe(true);
  });

  it('is invented: no address, phone or product name', () => {
    const text = JSON.stringify(set);
    expect(text).not.toMatch(/@[\w.-]+\.\w+/);
    expect(text).not.toMatch(/\d{3}[-. ]\d{3}[-. ]\d{4}/);
    expect(text.toLowerCase()).not.toContain('kvox');
  });

  it('lists each text once, sorted', () => {
    const texts = calibrationTexts(set);
    expect(new Set(texts).size).toBe(texts.length);
    expect([...texts].sort()).toEqual(texts);
  });
});

describe('evaluateModel', () => {
  const set = buildCalibrationSet(loadGoldenMeetings());
  const texts = calibrationTexts(set);

  it('measures a model, deterministically, with no missing vector', () => {
    const vectors = hashedNgramVectors(texts);
    const a = evaluateModel('stand-in', set, vectors);
    expect(a.missingVectors).toBe(0);
    expect(a.entities.pairs).toBe(set.entityPairs.length);
    expect(a.items.pairs).toBe(set.itemPairs.length);
    expect(evaluateModel('stand-in', set, vectors)).toEqual(a);
  });

  it('counts a pair with a missing vector as skipped, not as a miss', () => {
    const r = evaluateModel('empty', set, new Map());
    expect(r.missingVectors).toBe(set.entityPairs.length + set.itemPairs.length);
    expect(r.entities.pairs).toBe(0);
  });

  it('replays the OpenAI baseline unchanged when no calibration is given', () => {
    const vectors = hashedNgramVectors(texts);
    expect(evaluateModel('m', set, vectors).calibration).toEqual(OPENAI);
    expect(evaluateModel('m', set, vectors, { calibration: OPENAI })).toEqual(evaluateModel('m', set, vectors));
  });

  it('moves the recommendation up with the model baseline (a shared direction raises every cosine)', () => {
    const flat = evaluateModel('flat', set, hashedNgramVectors(texts));
    const lifted = evaluateModel('lifted', set, hashedNgramVectors(texts, { anisotropy: 0.9 }));
    expect(lifted.entities.negativeCosineP95!).toBeGreaterThan(flat.entities.negativeCosineP95!);
    expect(lifted.items.negativeCosineP95!).toBeGreaterThan(flat.items.negativeCosineP95!);
    const rec = recommendedCalibration(lifted);
    expect(rec.itemSameConfidentCosine).toBeGreaterThanOrEqual(rec.itemCosine);
  });

  it('keeps auto-link and auto-merge precision on a high-baseline model by calibrating it', () => {
    // The same lifted vectors, decided with the OpenAI numbers and with the bge numbers.
    const lifted = hashedNgramVectors(texts, { anisotropy: 0.9 });
    const withOpenAi = evaluateModel('lifted', set, lifted, { calibration: OPENAI });
    const withBge = evaluateModel('lifted', set, lifted, { calibration: BGE });
    const p = (n: number | null) => n ?? 1;
    expect(p(withBge.entities.autoLinked.precision)).toBeGreaterThanOrEqual(p(withOpenAi.entities.autoLinked.precision));
    expect(p(withBge.entities.autoLinkedBestContext.precision)).toBeGreaterThanOrEqual(
      p(withOpenAi.entities.autoLinkedBestContext.precision),
    );
    expect(p(withBge.items.confident.precision)).toBeGreaterThanOrEqual(p(withOpenAi.items.confident.precision));
    expect(withBge.items.candidates.fired).toBeLessThanOrEqual(withOpenAi.items.candidates.fired);
    expect(withBge.entities.surfaced.fp).toBeLessThanOrEqual(withOpenAi.entities.surfaced.fp);
  });

  it('is identical for the web edition: the catalog entry carries no calibration, so the baseline applies', () => {
    expect(KVOX_EMBEDDING.graphCalibration).toBeUndefined();
    expect(OPENAI).toEqual({ vectorFloor: 0.75, itemCosine: 0.8, itemSameConfidentCosine: 0.92 });
  });
});

describe('kvox-eval calibrate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kvox-calibrate-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('runs the self-test and prints a report', async () => {
    const c = capture();
    expect(await main(['calibrate', '--self-test'], c.io)).toBe(0);
    const text = c.out.join('\n');
    expect(text).toContain('Graph embedding calibration');
    expect(text).toContain('self-test:hashed-ngram');
    expect(text).toContain('auto-linked');
  });

  it('dumps the texts, then measures a recorded model against its catalog values', async () => {
    const textsFile = join(dir, 'texts.json');
    const c = capture();
    expect(await main(['calibrate', '--dump-texts', textsFile], c.io)).toBe(0);
    const texts = JSON.parse(readFileSync(textsFile, 'utf8')) as string[];
    expect(texts.length).toBeGreaterThan(100);

    const recorded = join(dir, 'bge.json');
    const vectors: Record<string, number[]> = {};
    for (const [text, v] of hashedNgramVectors(texts, { anisotropy: 0.9 })) vectors[text] = [...v];
    writeFileSync(recorded, JSON.stringify({ model: 'bge-small-en-v1.5-int8', vectors }));

    const jsonOut = join(dir, 'out', 'report.json');
    const r = capture();
    expect(await main(['calibrate', '--vectors', recorded, '--json', jsonOut], r.io)).toBe(0);
    expect(r.out.join('\n')).toContain('model bge-small-en-v1.5-int8');
    const [report] = JSON.parse(readFileSync(jsonOut, 'utf8'));
    expect(report.model).toBe('bge-small-en-v1.5-int8');
    expect(report.calibration).toEqual(BGE);
  });

  it('refuses no mode, an unknown flag and an unreadable vectors file', async () => {
    const none = capture();
    expect(await main(['calibrate'], none.io)).toBe(2);
    expect(none.err.join('\n')).toContain('--self-test');
    const bad = capture();
    expect(await main(['calibrate', '--nope'], bad.io)).toBe(2);
    const missing = capture();
    expect(await main(['calibrate', '--vectors', join(dir, 'absent.json')], missing.io)).toBe(2);
  });
});

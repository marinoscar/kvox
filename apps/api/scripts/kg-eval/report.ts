// kg:eval report (issue #362): one object, printed as a fixed-column table and
// optionally written as JSON (`--json`). `kgEvalReportSchema` is the JSON's
// contract — a tuning script that reads it can rely on its shape.

import { z } from 'zod';

import {
  autoLinkPrecision,
  BASE_REPORT_TYPES,
  commitmentRecall,
  entityCoverage,
  f1Of,
  precisionOf,
  ratio,
  recallOf,
  type RunScore,
} from './scorer';
import { KG_EVAL_TARGETS } from './targets';

const nullableRatio = z.number().min(0).max(1).nullable();

const targetMetric = z.object({ value: nullableRatio, target: z.number(), pass: z.boolean().nullable() });

export const kgEvalReportSchema = z.object({
  fixtures: z.number().int(),
  fixtureIds: z.array(z.string()),
  runner: z.string(),
  model: z.string().nullable(),
  types: z.array(
    z.object({
      type: z.string(),
      tp: z.number().int(),
      fp: z.number().int(),
      fn: z.number().int(),
      precision: nullableRatio,
      recall: nullableRatio,
      f1: nullableRatio,
    }),
  ),
  metrics: z.object({
    entityCoverage: targetMetric,
    commitmentRecall: targetMetric,
    autoLinkPrecision: targetMetric,
    evidenceValidity: z.object({ value: nullableRatio }),
    temporalAccuracy: z.object({ value: nullableRatio }),
  }),
  dropped: z.record(z.string(), z.number()),
  perFixture: z.array(
    z.object({ fixtureId: z.string(), tp: z.number().int(), fp: z.number().int(), fn: z.number().int() }),
  ),
  /** true when every target with a value meets it (an `n/a` target never fails). */
  targetsMet: z.boolean(),
});
export type KgEvalReport = z.infer<typeof kgEvalReportSchema>;

function target(value: number | null, t: number) {
  return { value, target: t, pass: value === null ? null : value >= t };
}

export function buildReport(
  run: RunScore,
  meta: { runner: string; model: string | null; fixtureIds: string[] },
): KgEvalReport {
  const relationTypes = Object.keys(run.types)
    .filter((t) => t.startsWith('relation:'))
    .sort();
  const types = [...BASE_REPORT_TYPES, ...relationTypes].map((type) => {
    const c = run.types[type] ?? { tp: 0, fp: 0, fn: 0 };
    return { type, ...c, precision: precisionOf(c), recall: recallOf(c), f1: f1Of(c) };
  });

  const metrics = {
    entityCoverage: target(entityCoverage(run), KG_EVAL_TARGETS.entityCoverage),
    commitmentRecall: target(commitmentRecall(run), KG_EVAL_TARGETS.commitmentRecall),
    autoLinkPrecision: target(autoLinkPrecision(run), KG_EVAL_TARGETS.autoLinkPrecision),
    evidenceValidity: { value: ratio(run.evidence.valid, run.evidence.total) },
    temporalAccuracy: { value: ratio(run.temporal.accurate, run.temporal.total) },
  };

  const dropped: Record<string, number> = { uncited: 0, invalid: 0, ...run.stats };

  const perFixture = run.perFixture.map((f) => {
    const sum = { tp: 0, fp: 0, fn: 0 };
    for (const c of Object.values(f.types)) {
      sum.tp += c.tp;
      sum.fp += c.fp;
      sum.fn += c.fn;
    }
    return { fixtureId: f.fixtureId, ...sum };
  });

  const targetsMet = [metrics.entityCoverage, metrics.commitmentRecall, metrics.autoLinkPrecision].every(
    (m) => m.pass !== false,
  );

  return {
    fixtures: run.fixtures,
    fixtureIds: meta.fixtureIds,
    runner: meta.runner,
    model: meta.model,
    types,
    metrics,
    dropped,
    perFixture,
    targetsMet,
  };
}

const fmt = (v: number | null) => (v === null ? 'n/a' : v.toFixed(3));
const pad = (s: string | number, n: number) => String(s).padEnd(n);

export function formatReport(r: KgEvalReport): string {
  const lines: string[] = [];
  lines.push(`kg:eval  fixtures=${r.fixtures}  runner=${r.runner}  model=${r.model ?? '-'}`);
  lines.push(`${pad('TYPE', 26)}${pad('TP', 6)}${pad('FP', 6)}${pad('FN', 6)}${pad('P', 7)}${pad('R', 7)}F1`);
  for (const t of r.types) {
    lines.push(
      `${pad(t.type, 26)}${pad(t.tp, 6)}${pad(t.fp, 6)}${pad(t.fn, 6)}${pad(fmt(t.precision), 7)}${pad(fmt(t.recall), 7)}${fmt(t.f1)}`,
    );
  }
  const verdict = (m: { pass: boolean | null }) => (m.pass === null ? '' : m.pass ? 'PASS' : 'FAIL');
  const m = r.metrics;
  lines.push(
    `${pad('ENTITY COVERAGE', 21)}${pad(fmt(m.entityCoverage.value), 8)}target ≥ ${m.entityCoverage.target.toFixed(2)}   ${verdict(m.entityCoverage)}`,
  );
  lines.push(
    `${pad('COMMITMENT RECALL', 21)}${pad(fmt(m.commitmentRecall.value), 8)}target ≥ ${m.commitmentRecall.target.toFixed(2)}   ${verdict(m.commitmentRecall)}`,
  );
  lines.push(
    `${pad('AUTO-LINK PRECISION', 21)}${pad(fmt(m.autoLinkPrecision.value), 8)}target ≥ ${m.autoLinkPrecision.target.toFixed(2)}   ${
      m.autoLinkPrecision.value === null ? '(no resolution in predictions)' : verdict(m.autoLinkPrecision)
    }`,
  );
  lines.push(
    `${pad('EVIDENCE VALIDITY', 21)}${pad(fmt(m.evidenceValidity.value), 8)}(cites that resolve to a fixture segment/note and whose quote is located)`,
  );
  lines.push(
    `${pad('TEMPORAL ACCURACY', 21)}${pad(fmt(m.temporalAccuracy.value), 8)}(matched temporal relations/items with equal precision and dates at that precision)`,
  );
  lines.push(
    `${pad('DROPPED (stats)', 21)}${Object.entries(r.dropped)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
  );
  return lines.join('\n');
}

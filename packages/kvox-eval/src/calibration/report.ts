// =============================================================================
// The calibration report (issue #681)
// =============================================================================

import type { DecisionSummary, ModelCalibrationReport } from './evaluate.js';
import { recommendedCalibration } from './evaluate.js';
import type { ThresholdPoint } from './metrics.js';

const pct = (n: number | null): string => (n === null ? '  n/a' : `${(n * 100).toFixed(1).padStart(5)}%`);
const num = (n: number | null): string => (n === null ? 'n/a' : n.toFixed(2));

function decision(label: string, d: DecisionSummary): string {
  return `  ${label.padEnd(34)} fired ${String(d.fired).padStart(4)}  tp ${String(d.tp).padStart(4)}  fp ${String(d.fp).padStart(3)}  precision ${pct(d.precision)}  recall ${pct(d.recall)}`;
}

function sweepRows(points: readonly ThresholdPoint[]): string[] {
  const shown = points.filter((p) => Math.round(p.threshold * 100) % 5 === 0);
  return shown.map(
    (p) => `    cosine >= ${p.threshold.toFixed(2)}   precision ${pct(p.precision)}  recall ${pct(p.recall)}  (tp ${p.tp}, fp ${p.fp}, fn ${p.fn})`,
  );
}

/**
 * Renders one or more model reports as text.
 *
 * @param reports - the reports.
 * @returns the report text.
 * @stability experimental
 */
export function formatCalibrationReport(reports: readonly ModelCalibrationReport[]): string {
  const lines: string[] = ['Graph embedding calibration (#681)', ''];
  for (const r of reports) {
    const cal = r.calibration;
    const rec = recommendedCalibration(r);
    lines.push(
      `model ${r.model}`,
      `  current  vectorFloor ${num(cal.vectorFloor)}  itemCosine ${num(cal.itemCosine)}  itemSameConfidentCosine ${num(cal.itemSameConfidentCosine)}`,
      `  rules    vectorFloor ${num(r.recommended.vectorFloor)}  itemCosine ${num(r.recommended.itemCosine)}  itemSameConfidentCosine ${num(r.recommended.itemSameConfidentCosine)}  (n/a: no threshold reached the target; keep the current value)`,
      `  suggest  vectorFloor ${num(rec.vectorFloor)}  itemCosine ${num(rec.itemCosine)}  itemSameConfidentCosine ${num(rec.itemSameConfidentCosine)}`,
      '',
      `  entity pairs ${r.entities.pairs} (${r.entities.positives} same)   negatives' cosine p95 ${num(r.entities.negativeCosineP95)}  max ${num(r.entities.negativeCosineMax)}`,
      decision('surfaced (score >= newThreshold)', r.entities.surfaced),
      decision('auto-linked (score >= autoLink)', r.entities.autoLinked),
      decision('auto-linked, best-case context', r.entities.autoLinkedBestContext),
      ...sweepRows(r.entities.cosineSweep),
      '',
      `  item pairs ${r.items.pairs} (${r.items.positives} duplicate)   negatives' cosine p95 ${num(r.items.negativeCosineP95)}  max ${num(r.items.negativeCosineMax)}`,
      decision('candidates (cosine >= itemCosine)', r.items.candidates),
      decision('confident same (no flag)', r.items.confident),
      ...sweepRows(r.items.cosineSweep),
      ...(r.missingVectors > 0 ? ['', `  ${r.missingVectors} pair(s) skipped: no vector recorded for a text`] : []),
      '',
    );
  }
  return lines.join('\n');
}

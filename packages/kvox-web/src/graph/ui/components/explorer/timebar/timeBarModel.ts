/**
 * The TimeBar's data model (GIC-15, #676): the API's activity response turned
 * into columns to draw, and into the sets of nodes the canvas dims. Pure.
 */

import type {
  GraphActivityBucket,
  GraphActivityPoint,
  GraphActivityResponse,
} from '../../../../headless/clients/graph.js';
import {
  DAY_MS,
  addBuckets,
  bucketStart,
  bucketsBetween,
  overlaps,
  parseDay,
  type TimeRange,
} from './timeAxis.js';

/**
 * One drawn column: a bucket, its stacked evidence by type, and the selection's overlay.
 *
 * @stability experimental
 */
export interface TimeColumn {
  /** UTC ms of the bucket start. */
  start: number;
  /** UTC ms of the next bucket start (exclusive). */
  end: number;
  /** Evidence attributions in the bucket. */
  total: number;
  /** Per type. */
  byType: Record<string, number>;
  /** Evidence attributions of the selected nodes in the bucket. */
  overlay: number;
}

/** The first and last instant the data covers, widened to whole buckets, or `null` without data. */
export function activityExtent(
  response: Pick<GraphActivityResponse, 'series' | 'bucket'> | null,
): [number, number] | null {
  if (!response || response.series.length === 0) return null;
  const first = parseDay(response.series[0].start);
  const last = parseDay(response.series[response.series.length - 1].start);
  if (first === null || last === null) return null;
  return [first, addBuckets(last, response.bucket, 1)];
}

/** Types in stack order: the busiest first, so they sit at the bottom; ties by key, so the order is stable. */
export function stackOrder(series: GraphActivityResponse['series']): string[] {
  const totals = new Map<string, number>();
  for (const bucket of series) {
    for (const [type, count] of Object.entries(bucket.byType)) totals.set(type, (totals.get(type) ?? 0) + count);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([type]) => type);
}

/**
 * One column per bucket in `domain`, empty buckets included, with the
 * selection's summed series as `overlay`.
 */
export function buildColumns(
  response: GraphActivityResponse | null,
  domain: readonly [number, number],
  bucket: GraphActivityBucket,
  selectedIds: readonly string[],
): TimeColumn[] {
  const byStart = new Map<number, GraphActivityResponse['series'][number]>();
  for (const row of response?.series ?? []) {
    const at = parseDay(row.start);
    if (at !== null) byStart.set(at, row);
  }
  const overlay = new Map<number, number>();
  for (const id of selectedIds) {
    for (const point of response?.byEntity[id] ?? []) {
      const at = parseDay(point.start);
      if (at !== null) overlay.set(at, (overlay.get(at) ?? 0) + point.count);
    }
  }
  return bucketsBetween(domain[0], domain[1], bucket).map((start) => {
    const row = byStart.get(start);
    return {
      start,
      end: addBuckets(start, bucket, 1),
      total: row?.total ?? 0,
      byType: row?.byType ?? {},
      overlay: overlay.get(start) ?? 0,
    };
  });
}

/** Whether any of an entity's buckets overlaps `[from, to)`. */
function pointsOverlap(
  points: readonly GraphActivityPoint[],
  bucket: GraphActivityBucket,
  from: number,
  to: number,
): boolean {
  for (const point of points) {
    const start = parseDay(point.start);
    if (start !== null && overlaps(start, addBuckets(start, bucket, 1), from, to)) return true;
  }
  return false;
}

/** The entities with evidence in `[from, to)`. */
export function activeEntities(
  response: Pick<GraphActivityResponse, 'byEntity' | 'bucket'>,
  from: number,
  to: number,
): Set<string> {
  const active = new Set<string>();
  for (const [id, points] of Object.entries(response.byEntity)) {
    if (pointsOverlap(points, response.bucket, from, to)) active.add(id);
  }
  return active;
}

/** {@link activeEntities} for a brush range; `null` for a range that is not two dates. */
export function activeInRange(
  response: Pick<GraphActivityResponse, 'byEntity' | 'bucket'>,
  range: TimeRange,
): Set<string> | null {
  const from = parseDay(range.from);
  const to = parseDay(range.to);
  return from === null || to === null ? null : activeEntities(response, from, to);
}

/**
 * The nodes to dim: every visible id outside `active`. `null` (nothing to
 * dim) when there is no filter, and when it would dim everything: an empty
 * window is shown by the empty histogram, not by a blank canvas.
 */
export function dimmedFrom(visible: Iterable<string>, active: ReadonlySet<string> | null): Set<string> | null {
  if (!active) return null;
  const dimmed = new Set<string>();
  let total = 0;
  for (const id of visible) {
    total += 1;
    if (!active.has(id)) dimmed.add(id);
  }
  return total > 0 && dimmed.size === total ? null : dimmed;
}

/** The index of the bucket holding `ms`, counted from the bucket starting at `first`. */
export function bucketIndex(first: number, ms: number, bucket: GraphActivityBucket): number {
  if (bucket === 'week') return Math.floor((bucketStart(ms, 'week') - first) / (7 * DAY_MS));
  const a = new Date(first);
  const b = new Date(ms);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

/** An SVG path of the totals as a filled area in a `width` by `height` box (the compact strip). */
export function areaPath(columns: readonly TimeColumn[], width: number, height: number): string {
  if (columns.length === 0) return '';
  const max = Math.max(1, ...columns.map((c) => c.total));
  const step = width / columns.length;
  const y = (total: number) => height - (total / max) * (height - 2);
  const points = columns.map((c, i) => `${(i * step + step / 2).toFixed(1)},${y(c.total).toFixed(1)}`);
  return `M0,${height} L${points.join(' L')} L${width},${height} Z`;
}

// =============================================================================
// Related sources — graph evidence fused with hybrid search (#372; spec §9.1, §9.4)
// =============================================================================
//
// PURE. Two already-ranked arms become one list:
//
//   1. the TEXT arm — `SearchService.search(q = entity label)`, whose order is
//      already FTS + vector reciprocal-rank-fused internally;
//   2. the GRAPH arm — documents cited by the entity's readable graph rows,
//      newest first.
//
// They are fused with `reciprocalRankFusion()` VERBATIM (spec §9.1 rejects a
// second RRF implementation), and only afterwards multiplied by recency
// (`0.5 ^ (ageDays / 90)`) and confidence (the mean confidence of the entity's
// cited rows in that document; 1 for a text-only hit).
//
// ⚠ THE TEXT ARM IS LOAD-BEARING, NOT A FALLBACK (§9.4): a document that
// mentions the entity but that extraction never linked still surfaces, with
// `inGraph: false`. Graph-only answers are forbidden by design.
// =============================================================================

import { reciprocalRankFusion } from '../../search/search-fusion';
import { BRIEF_RELATED_LIMIT, type RelatedSource } from './dto/entity-brief.dto';

/** Half-life of the recency factor, in days. */
export const RELATED_RECENCY_HALF_LIFE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RelatedKind = 'transcript' | 'note';

/** `kind:id` — the key both arms and the fusion share. */
export const relatedKey = (kind: RelatedKind, id: string): string => `${kind}:${id}`;

export interface TextArmHit {
  kind: RelatedKind;
  id: string;
  title: string;
  snippetHtml: string | null;
  startMs: number | null;
}

export interface GraphArmHit {
  kind: RelatedKind;
  id: string;
  /** Mean confidence of the entity's cited rows in this document, in [0, 1]. */
  confidence: number;
}

export interface RelatedDoc {
  title: string;
  occurredAt: Date | null;
}

export interface FuseRelatedInput {
  /** In the text arm's own rank order. */
  text: readonly TextArmHit[];
  /** In the graph arm's own rank order. */
  graph: readonly GraphArmHit[];
  /** Title and date per key, for every document the caller may still view. A key missing here is dropped. */
  docs: ReadonlyMap<string, RelatedDoc>;
  now: Date;
  limit?: number;
}

/** `0.5 ^ (ageDays / 90)`; an undated document (or one in the future) is not decayed. */
export function recencyFactor(occurredAt: Date | null, now: Date): number {
  if (occurredAt === null) return 1;
  const ageDays = Math.max(0, (now.getTime() - occurredAt.getTime()) / DAY_MS);
  return Math.pow(0.5, ageDays / RELATED_RECENCY_HALF_LIFE_DAYS);
}

export function fuseRelatedSources(input: FuseRelatedInput): RelatedSource[] {
  const textKeys = input.text.map((h) => relatedKey(h.kind, h.id));
  const graphKeys = input.graph.map((h) => relatedKey(h.kind, h.id));
  const fused = reciprocalRankFusion([textKeys, graphKeys]);

  const textByKey = new Map(input.text.map((h) => [relatedKey(h.kind, h.id), h]));
  const graphByKey = new Map(input.graph.map((h) => [relatedKey(h.kind, h.id), h]));

  const rows: RelatedSource[] = [];
  for (const [key, rrf] of fused) {
    const doc = input.docs.get(key);
    if (!doc) continue;
    const text = textByKey.get(key);
    const graph = graphByKey.get(key);
    const [kind, id] = key.split(':') as [RelatedKind, string];
    const confidence = graph ? clamp01(graph.confidence) : 1;
    rows.push({
      kind,
      id,
      title: doc.title,
      snippetHtml: text?.snippetHtml ?? null,
      startMs: text?.startMs ?? null,
      score: rrf * recencyFactor(doc.occurredAt, input.now) * confidence,
      inGraph: graph !== undefined,
      occurredAt: doc.occurredAt ? doc.occurredAt.toISOString() : null,
    });
  }

  rows.sort((a, b) => b.score - a.score || (relatedKey(a.kind, a.id) < relatedKey(b.kind, b.id) ? -1 : 1));
  return rows.slice(0, input.limit ?? BRIEF_RELATED_LIMIT);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

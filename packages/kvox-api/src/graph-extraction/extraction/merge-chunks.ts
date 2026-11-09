// =============================================================================
// mergeChunkResults — the reduce step of chunked extraction (#777, epic #773)
// =============================================================================
//
// PURE. Each chunk of a long note is validated on its own (refs `e1…`, `r1…`,
// `i1…` are local to the chunk). This merges the per-chunk results into the one
// result `addDeterministicRows` and the writer expect:
//
//   - ENTITIES are deduped by type + normalized label/alias (the resolution
//     stage's `normalizedNames`); a re-stated KNOWN entity (`k#` ref) merges by
//     ref. A MEETING is the exception (#780): two meetings of one record can share
//     a title ("weekly sync"), so it dedupes by normalized title + `occurredOn`. Evidence is unioned, aliases unioned, props fill gaps (first wins).
//   - Local refs are renumbered `e1…` and every relation / item endpoint is
//     re-pointed to the merged ref. A known `{ entityId }` endpoint is untouched.
//   - RELATIONS with the same type, endpoints, dates and props, and ITEMS with
//     the same kind + statement hash, are one row with unioned evidence.
//   - A relation whose endpoints merged into one entity is dropped (`invalid`).
//
// Evidence offsets are already absolute (the handler shifts them per chunk), so
// a union is a plain de-duplication on the evidence's identity.
// =============================================================================

import { normalizedNames } from '../resolution/candidate.service.js';
import { normalizeForMatch } from './extraction-context.js';
import type { EndpointRef, ProposalItemFlag } from '../proposals/proposal-payload.schema.js';
import type { EvidenceDraft, ProposedRow, ValidationStats } from './validate.js';

/** One chunk's validated answer, evidence offsets already absolute. */
export interface ChunkOutcome {
  rows: ProposedRow[];
  topics: string[];
  stats: ValidationStats;
}

export type MergedResult = { ok: true; rows: ProposedRow[]; topics: string[]; stats: ValidationStats };

const KNOWN_REF = /^k\d+$/;
const MAX_ALIASES = 10;

function evidenceKey(e: EvidenceDraft): string {
  if (e.source === 'source_text') return `D:${e.sourceObjectId}:${e.charStart}:${e.charEnd}`;
  return e.source === 'segment'
    ? `S:${e.segmentId}:${e.charStart}:${e.charEnd}`
    : `N:${e.noteVersion}:${e.charStart}:${e.charEnd}:${e.charStart === null ? e.quote : ''}`;
}

function unionEvidence(into: EvidenceDraft[], more: EvidenceDraft[]): void {
  const seen = new Set(into.map(evidenceKey));
  for (const e of more) {
    const key = evidenceKey(e);
    if (!seen.has(key)) {
      seen.add(key);
      into.push(e);
    }
  }
}

type EntityPayloadLike = { type: string; label: string; aliases: string[]; props: Record<string, unknown> };

/**
 * The keys an entity is deduped under. A Meeting is one key: its normalized title and the date
 * it occurred on (empty when none is stated), so a record's weekly meetings stay apart and one
 * meeting restated in two chunks becomes one row.
 */
export function entityDedupKeys(payload: EntityPayloadLike): string[] {
  if (payload.type === 'Meeting') {
    const day = typeof payload.props.occurredOn === 'string' ? payload.props.occurredOn : '';
    return [`Meeting|${normalizeForMatch(payload.label)}|${day}`];
  }
  return normalizedNames(payload.label, payload.aliases).map((n) => `${payload.type}|${n}`);
}

function unionFlags(a: ProposalItemFlag[], b: ProposalItemFlag[]): ProposalItemFlag[] {
  return [...new Set([...a, ...b])];
}

type EntityRow = Extract<ProposedRow, { kind: 'entity' }>;
type RelationRow = Extract<ProposedRow, { kind: 'relation' }>;
type ItemRow = Extract<ProposedRow, { kind: 'item' }>;

function mapEndpoint(ep: EndpointRef | null, refMap: Map<string, string>): EndpointRef | null {
  if (ep === null || 'entityId' in ep) return ep;
  return { ref: refMap.get(ep.ref) ?? ep.ref };
}

function endpointKey(ep: EndpointRef | null): string {
  if (ep === null) return '-';
  return 'entityId' in ep ? `id:${ep.entityId}` : `ref:${ep.ref}`;
}

/** Merge per-chunk outcomes (in chunk order) into one result. Never throws. */
export function mergeChunkResults(outcomes: ChunkOutcome[]): MergedResult {
  const entities: EntityRow[] = [];
  const byName = new Map<string, EntityRow>(); // `${type}|${normalized}` → merged row
  const byKnownRef = new Map<string, EntityRow>();
  const relations: RelationRow[] = [];
  const relationByKey = new Map<string, RelationRow>();
  const items: ItemRow[] = [];
  const itemByKey = new Map<string, ItemRow>();
  const dropped = { uncited: 0, invalid: 0, unknownType: 0, dangling: 0 };
  const topics: string[] = [];
  let nextEntity = 0;

  for (const outcome of outcomes) {
    for (const key of Object.keys(dropped) as Array<keyof typeof dropped>) dropped[key] += outcome.stats.dropped[key];
    for (const t of outcome.topics) if (!topics.includes(t)) topics.push(t);

    const refMap = new Map<string, string>(); // chunk-local ref → merged ref
    for (const row of outcome.rows) {
      if (row.kind !== 'entity') continue;
      const names = entityDedupKeys(row.payload);
      const known = KNOWN_REF.test(row.payload.ref) ? byKnownRef.get(row.payload.ref) : undefined;
      const existing = known ?? names.map((n) => byName.get(n)).find((m) => m !== undefined);
      if (existing) {
        refMap.set(row.payload.ref, existing.payload.ref);
        unionEvidence(existing.evidence, row.evidence);
        existing.flags = unionFlags(existing.flags, row.flags);
        const aliases = new Set(existing.payload.aliases);
        for (const a of [row.payload.label, ...row.payload.aliases]) {
          if (a !== existing.payload.label && aliases.size < MAX_ALIASES) aliases.add(a);
        }
        existing.payload.aliases = [...aliases];
        existing.payload.props = { ...row.payload.props, ...existing.payload.props };
        for (const n of names) if (!byName.has(n)) byName.set(n, existing);
        continue;
      }
      const isKnown = KNOWN_REF.test(row.payload.ref);
      const ref = isKnown ? row.payload.ref : `e${++nextEntity}`;
      refMap.set(row.payload.ref, ref);
      const merged: EntityRow = {
        ...row,
        payload: { ...row.payload, ref, aliases: [...row.payload.aliases], props: { ...row.payload.props } },
        flags: [...row.flags],
        evidence: [...row.evidence],
      };
      entities.push(merged);
      if (isKnown) byKnownRef.set(ref, merged);
      for (const n of names) byName.set(n, merged);
    }

    for (const row of outcome.rows) {
      if (row.kind === 'relation') {
        const from = mapEndpoint(row.payload.from, refMap)!;
        const to = mapEndpoint(row.payload.to, refMap)!;
        if (endpointKey(from) === endpointKey(to)) {
          dropped.invalid += 1;
          continue;
        }
        const key = [
          row.payload.type,
          endpointKey(from),
          endpointKey(to),
          row.payload.validFrom,
          row.payload.validTo,
          JSON.stringify(row.payload.props),
        ].join('|');
        const existing = relationByKey.get(key);
        if (existing) {
          unionEvidence(existing.evidence, row.evidence);
          existing.flags = unionFlags(existing.flags, row.flags);
          continue;
        }
        const merged: RelationRow = {
          ...row,
          payload: { ...row.payload, from, to },
          flags: [...row.flags],
          evidence: [...row.evidence],
        };
        relationByKey.set(key, merged);
        relations.push(merged);
      } else if (row.kind === 'item') {
        const subject = mapEndpoint(row.payload.subject, refMap);
        const owner = mapEndpoint(row.payload.owner, refMap);
        const counterparty = mapEndpoint(row.payload.counterparty, refMap);
        const key = [row.payload.kind, row.payload.statementHash, endpointKey(subject)].join('|');
        const existing = itemByKey.get(key);
        if (existing) {
          unionEvidence(existing.evidence, row.evidence);
          existing.flags = unionFlags(existing.flags, row.flags);
          continue;
        }
        const merged: ItemRow = {
          ...row,
          payload: { ...row.payload, subject, owner, counterparty },
          flags: [...row.flags],
          evidence: [...row.evidence],
        };
        itemByKey.set(key, merged);
        items.push(merged);
      }
    }
  }

  relations.forEach((r, i) => (r.payload.ref = `r${i + 1}`));
  items.forEach((r, i) => (r.payload.ref = `i${i + 1}`));
  const rows: ProposedRow[] = [...entities, ...relations, ...items];
  const quoteNotLocated = rows.filter((r) => r.flags.includes('quote_not_located')).length;
  return {
    ok: true,
    rows,
    topics: topics.slice(0, 50),
    stats: {
      proposed: { entities: entities.length, relations: relations.length, items: items.length },
      dropped,
      quoteNotLocated,
    },
  };
}

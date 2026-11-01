// =============================================================================
// Filter parameters of the graph read routes (#370)
// =============================================================================
//
// `type`, `types`, `relationTypes` and `kinds` arrive as comma-separated keys
// (or arrays, on the expand body). Each is validated against the CALLER'S
// effective schema (#354): an unknown key is a 400 naming it, never a silently
// empty result — a typo'd filter that returns nothing looks exactly like an
// empty graph.
// =============================================================================

import { BadRequestException } from '@nestjs/common';

import { localDayStart } from '../../core/index.js';
import { ITEM_KINDS, type EffectiveSchema, type KgItemKind } from '@marinoscar/kvox-contract/ontology';

import { AsOfParseError, parseAsOf } from './as-of.js';
import { TIMELINE_KINDS, type TimelineKind } from './dto/graph-read.dto.js';

/** `"A, B,,C"` → `['A','B','C']`, de-duplicated; `undefined` for an absent/empty value. */
export function parseCsv(raw: string | readonly string[] | undefined | null): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parts = (typeof raw === 'string' ? raw.split(',') : [...raw]).map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length === 0 ? undefined : [...new Set(parts)];
}

function unknownKeys(param: string, keys: string[], allowed: string[]): BadRequestException {
  return new BadRequestException({
    message: `Unknown ${param}: ${keys.join(', ')}.`,
    details: { param, unknown: keys, allowed },
  });
}

/** Entity-storage type keys of the caller's schema (not item types). */
export function resolveEntityTypes(schema: EffectiveSchema, raw: string | undefined, param = 'type'): string[] | undefined {
  const keys = parseCsv(raw);
  if (!keys) return undefined;
  const allowed = schema.entityTypes.filter((t) => t.storage === 'entity').map((t) => t.key);
  const bad = keys.filter((k) => !allowed.includes(k));
  if (bad.length > 0) throw unknownKeys(param, bad, allowed);
  return keys;
}

export interface NodeTypeFilter {
  entityTypes: string[];
  itemKinds: KgItemKind[];
}

/**
 * A node filter: entity type keys (`Person`), item type keys (`Commitment`) or
 * item kinds (`commitment`), mixed freely. `undefined` (param absent, or a
 * string with no keys) = keep everything; an explicitly EMPTY array = keep no
 * node type at all (an empty result, not "no filter").
 */
export function resolveNodeTypes(
  schema: EffectiveSchema,
  raw: string | readonly string[] | undefined,
  param = 'types',
): NodeTypeFilter | undefined {
  if (Array.isArray(raw) && raw.length === 0) return { entityTypes: [], itemKinds: [] };
  const keys = parseCsv(raw);
  if (!keys) return undefined;
  const entityTypes: string[] = [];
  const itemKinds = new Set<KgItemKind>();
  const bad: string[] = [];
  for (const key of keys) {
    if ((ITEM_KINDS as readonly string[]).includes(key)) {
      itemKinds.add(key as KgItemKind);
      continue;
    }
    const type = schema.entityType(key);
    if (!type) bad.push(key);
    else if (type.storage === 'item' && type.itemKind) itemKinds.add(type.itemKind);
    else entityTypes.push(key);
  }
  if (bad.length > 0) {
    throw unknownKeys(param, bad, [...schema.entityTypes.map((t) => t.key), ...ITEM_KINDS]);
  }
  return { entityTypes, itemKinds: [...itemKinds] };
}

/** Relation type keys of the caller's schema, of any representation. */
export function resolveRelationTypes(
  schema: EffectiveSchema,
  raw: string | readonly string[] | undefined,
  param = 'relationTypes',
): string[] | undefined {
  const keys = parseCsv(raw);
  if (!keys) return undefined;
  const bad = keys.filter((k) => !schema.relationType(k));
  if (bad.length > 0) throw unknownKeys(param, bad, schema.relationTypes.map((r) => r.key));
  return keys;
}

/** Timeline event kinds; `undefined` = all of them. */
export function resolveTimelineKinds(raw: string | undefined): Set<TimelineKind> {
  const keys = parseCsv(raw);
  if (!keys) return new Set(TIMELINE_KINDS);
  const bad = keys.filter((k) => !(TIMELINE_KINDS as readonly string[]).includes(k));
  if (bad.length > 0) throw unknownKeys('kinds', bad, [...TIMELINE_KINDS]);
  return new Set(keys as TimelineKind[]);
}

/** `as_of` → the instant it names (absent = now), or a 400. */
export function asOfOr400(raw: string | undefined, now: Date = new Date()): Date {
  try {
    return parseAsOf(raw, now);
  } catch (err) {
    if (err instanceof AsOfParseError) throw new BadRequestException(err.message);
    throw err;
  }
}

/**
 * A `since` / `from` / `to` bound over a TIMESTAMP column (a recording time, a mention's
 * `created_at`) → the instant it names, or a 400.
 *
 * THE RULE, once: a BARE DAY (`2026-10-26`) in an instant filter means LOCAL MIDNIGHT in the
 * requester's `timeZone`, so "from the 26th" starts when the user's 26th starts. A full ISO
 * datetime is itself. This is deliberately NOT {@link asOfOr400}: `as_of` is evaluated against
 * calendar predicates (a relation's validity range, an item's `occurred_at`), which are floating
 * dates at UTC midnight, so a bare `as_of` stays `00:00:00Z` whatever anybody's zone.
 *
 * @param raw - the raw parameter.
 * @param timeZone - the requester's IANA zone.
 * @param now - the clock (never read here).
 * @returns the instant.
 */
export function instantBoundOr400(raw: string, timeZone: string, now: Date = new Date()): Date {
  // Calendar-impossible days (`2026-02-30`) and malformed values are the parser's 400.
  const parsed = asOfOr400(raw, now);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? localDayStart(raw, timeZone) : parsed;
}

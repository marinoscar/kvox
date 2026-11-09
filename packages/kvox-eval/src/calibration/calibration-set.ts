// =============================================================================
// The labelled calibration set (issue #681)
// =============================================================================
//
// Pairs the graph's embedding thresholds are measured on:
//
//   entity pairs  two names of one type, `same` = the same real-world entity.
//   item pairs    two statements of one kind, `duplicate` = the same fact.
//
// Two sources, both INVENTED (the golden set's rule; no real person, company or
// product):
//
//   golden   derived from the labelled meetings: an entity's label against its
//            own aliases (positives) and against other entities of its type
//            (negatives, the lexically closest first); items of one kind and
//            subject in one meeting with different statements (negatives).
//   hand     `fixtures/embedding-calibration/pairs.json`: hard cases on purpose,
//            including every positive item pair (a paraphrase cannot be derived).
//
// PURE and deterministic: the same fixtures give the same set, in the same order.
// The texts are built with the SAME profile-text builders `kg.embed` and
// resolution use, so a vector here is comparable to a vector in the product.
// =============================================================================

import { readFileSync } from 'fs';
import { join, resolve } from 'path';

import { z } from 'zod';

import type { GoldenFixture } from '../fixtures/index.js';
import { buildEntityProfileText, buildItemProfileText, normalizeForMatch } from './internals.js';
import { pgTrigramSimilarity } from './metrics.js';

/** `src/calibration` and `dist/calibration` both sit two levels below the package root. */
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

/**
 * The committed hand-authored pairs (`fixtures/embedding-calibration/pairs.json`).
 *
 * @stability experimental
 */
export const CALIBRATION_PAIRS_PATH = join(PACKAGE_ROOT, 'fixtures', 'embedding-calibration', 'pairs.json');

/**
 * One labelled entity-name pair.
 *
 * @stability experimental
 */
export interface EntityPair {
  /** Stable id within the set. */
  id: string;
  /** The ontology type of both names. */
  type: string;
  /** The first name. */
  a: string;
  /** The second name. */
  b: string;
  /** True when both name the same entity. */
  same: boolean;
  /** Where the pair came from. */
  origin: 'golden-alias' | 'golden-distinct' | 'hand';
}

/**
 * One labelled statement pair.
 *
 * @stability experimental
 */
export interface ItemPair {
  /** Stable id within the set. */
  id: string;
  /** The item kind of both statements. */
  kind: string;
  /** The first statement. */
  a: string;
  /** The second statement. */
  b: string;
  /** True when both state the same fact. */
  duplicate: boolean;
  /** Where the pair came from. */
  origin: 'golden-distinct' | 'hand';
}

/**
 * The calibration set.
 *
 * @stability experimental
 */
export interface CalibrationSet {
  /** Entity-name pairs. */
  entityPairs: EntityPair[];
  /** Statement pairs. */
  itemPairs: ItemPair[];
}

const handPairsSchema = z.object({
  version: z.literal(1),
  note: z.string().optional(),
  entities: z.array(z.object({ type: z.string(), a: z.string().min(1), b: z.string().min(1), same: z.boolean() })),
  items: z.array(z.object({ kind: z.string(), a: z.string().min(1), b: z.string().min(1), duplicate: z.boolean() })),
});

/**
 * A pairs file that cannot be read.
 *
 * @stability experimental
 */
export class CalibrationSetError extends Error {}

/**
 * Reads the hand-authored pairs.
 *
 * @param file - the JSON file; default the committed {@link CALIBRATION_PAIRS_PATH}.
 * @returns the entity and item pairs, ids assigned in file order.
 * @throws {@link CalibrationSetError} when the file is not valid JSON or does not match its schema.
 * @stability experimental
 */
export function loadHandPairs(file: string = CALIBRATION_PAIRS_PATH): CalibrationSet {
  let parsed: z.infer<typeof handPairsSchema>;
  try {
    parsed = handPairsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    throw new CalibrationSetError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    entityPairs: parsed.entities.map((e, i) => ({ id: `hand-e${i + 1}`, origin: 'hand' as const, ...e })),
    itemPairs: parsed.items.map((p, i) => ({ id: `hand-i${i + 1}`, origin: 'hand' as const, ...p })),
  };
}

/**
 * How many pairs of each derived kind {@link buildCalibrationSet} keeps.
 *
 * @stability experimental
 */
export interface CalibrationSetOptions {
  /** Most alias positives kept (default 120). */
  maxAliasPairs?: number;
  /** Most distinct-entity negatives kept (default 200; the lexically closest half first). */
  maxDistinctEntityPairs?: number;
  /** Most distinct-statement negatives kept (default 120). */
  maxDistinctItemPairs?: number;
}

interface EntityClass {
  type: string;
  label: string;
  forms: Set<string>;
  aliases: string[];
}

/** Evenly spaced picks, deterministic. */
function stride<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) out.push(items[Math.floor((i * items.length) / max)]);
  return out;
}

/**
 * Derives the set from the golden fixtures and merges the hand-authored pairs.
 *
 * @param fixtures - the golden meetings.
 * @param hand - hand-authored pairs (default: the committed file).
 * @param options - caps.
 * @returns the set, deterministic.
 * @stability experimental
 */
export function buildCalibrationSet(
  fixtures: readonly GoldenFixture[],
  hand: CalibrationSet = loadHandPairs(),
  options: CalibrationSetOptions = {},
): CalibrationSet {
  const maxAlias = options.maxAliasPairs ?? 120;
  const maxEntityNeg = options.maxDistinctEntityPairs ?? 200;
  const maxItemNeg = options.maxDistinctItemPairs ?? 120;

  // --- entities: one class per (type, normalized label) ----------------------
  const classes = new Map<string, EntityClass>();
  const mentions: Array<{ type: string; label: string; aliases: readonly string[] }> = [];
  for (const f of fixtures) {
    for (const e of f.labels.entities) mentions.push({ type: e.type, label: e.label, aliases: e.aliases });
    for (const e of f.knownEntities) mentions.push({ type: e.type, label: e.label, aliases: e.aliases });
  }
  for (const m of mentions) {
    const key = `${m.type}|${normalizeForMatch(m.label)}`;
    let cls = classes.get(key);
    if (!cls) {
      cls = { type: m.type, label: m.label, forms: new Set([normalizeForMatch(m.label)]), aliases: [] };
      classes.set(key, cls);
    }
    for (const alias of m.aliases) {
      const n = normalizeForMatch(alias);
      if (n && !cls.forms.has(n)) {
        cls.forms.add(n);
        cls.aliases.push(alias);
      }
    }
  }
  const ordered = [...classes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, c]) => c);

  // An alias that is also a surface form of another class (a bare first name) is ambiguous: not a positive.
  const formOwners = new Map<string, number>();
  for (const c of ordered) for (const form of c.forms) formOwners.set(`${c.type}|${form}`, (formOwners.get(`${c.type}|${form}`) ?? 0) + 1);

  const aliasPairs: EntityPair[] = [];
  for (const c of ordered) {
    for (const alias of c.aliases) {
      if ((formOwners.get(`${c.type}|${normalizeForMatch(alias)}`) ?? 0) > 1) continue;
      aliasPairs.push({ id: '', type: c.type, a: c.label, b: alias, same: true, origin: 'golden-alias' });
    }
  }

  const negatives: Array<EntityPair & { closeness: number }> = [];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const x = ordered[i];
      const y = ordered[j];
      if (x.type !== y.type) continue;
      if ([...x.forms].some((form) => y.forms.has(form))) continue;
      negatives.push({
        id: '',
        type: x.type,
        a: x.label,
        b: y.label,
        same: false,
        origin: 'golden-distinct',
        closeness: pgTrigramSimilarity(normalizeForMatch(x.label), normalizeForMatch(y.label)),
      });
    }
  }
  // The hard half (lexically closest) first, then an even sample of the rest.
  negatives.sort((p, q) => q.closeness - p.closeness || (p.a + p.b < q.a + q.b ? -1 : 1));
  const hardCount = Math.ceil(maxEntityNeg / 2);
  const distinctEntities = [...negatives.slice(0, hardCount), ...stride(negatives.slice(hardCount), maxEntityNeg - hardCount)];

  const entityPairs: EntityPair[] = [
    ...stride(aliasPairs, maxAlias),
    ...distinctEntities.map(({ closeness: _closeness, ...p }) => p),
    ...hand.entityPairs,
  ].map((p, i) => ({ ...p, id: p.origin === 'hand' ? p.id : `${p.origin === 'golden-alias' ? 'alias' : 'distinct'}-e${i + 1}` }));

  // --- items: same fixture, kind and subject, different statements -----------
  const itemNegatives: ItemPair[] = [];
  for (const f of fixtures) {
    const groups = new Map<string, string[]>();
    for (const item of f.labels.items) {
      const key = `${item.kind}|${item.subject}`;
      groups.set(key, [...(groups.get(key) ?? []), item.statement]);
    }
    for (const [key, statements] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const kind = key.split('|')[0];
      for (let i = 0; i < statements.length; i += 1) {
        for (let j = i + 1; j < statements.length; j += 1) {
          if (statements[i] === statements[j]) continue;
          itemNegatives.push({ id: '', kind, a: statements[i], b: statements[j], duplicate: false, origin: 'golden-distinct' });
        }
      }
    }
  }
  const itemPairs: ItemPair[] = [...stride(itemNegatives, maxItemNeg), ...hand.itemPairs].map((p, i) => ({
    ...p,
    id: p.origin === 'hand' ? p.id : `distinct-i${i + 1}`,
  }));

  return { entityPairs, itemPairs };
}

/** The text an entity name is embedded from (the product's own profile text). */
export function entityText(type: string, name: string): string {
  return buildEntityProfileText({ type, label: name });
}

/** The text a statement is embedded from (the product's own profile text). */
export function itemText(kind: string, statement: string): string {
  return buildItemProfileText({ kind, title: null, statement });
}

/**
 * Every distinct text the set needs a vector for, sorted: what a host embeds with
 * its model and records for {@link recordedVectors}.
 *
 * @param set - the set.
 * @returns the unique texts.
 * @stability experimental
 */
export function calibrationTexts(set: CalibrationSet): string[] {
  const texts = new Set<string>();
  for (const p of set.entityPairs) {
    texts.add(entityText(p.type, p.a));
    texts.add(entityText(p.type, p.b));
  }
  for (const p of set.itemPairs) {
    texts.add(itemText(p.kind, p.a));
    texts.add(itemText(p.kind, p.b));
  }
  return [...texts].sort();
}

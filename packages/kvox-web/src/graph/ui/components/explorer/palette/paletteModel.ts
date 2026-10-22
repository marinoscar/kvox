/**
 * The command palette's rules, as pure functions (GIC-09, #670; epic #661).
 *
 * NO REACT, NO SIGMA. A test drives them with a plain graphology graph; the
 * palette component only renders what they return.
 *
 *   - {@link parsePaletteQuery} splits `type:Person joe` into the free text and
 *     the type tokens, and says which tokens name no known type.
 *   - {@link canvasMatches} is the local fuzzy match over the labels of the
 *     nodes already on the canvas (the "On canvas" section).
 *   - {@link seedPlan} decides what adding or replacing a seed means, including
 *     the cap of {@link MAX_PALETTE_SEEDS} and the message when it is exceeded.
 */

import type { ExplorerGraph } from '../explorerModel.js';

/** The most seeds `?seed=` may carry; the palette refuses to add an eleventh. */
export const MAX_PALETTE_SEEDS = 10;

/** The most rows the "On canvas" section shows. */
export const CANVAS_RESULT_LIMIT = 6;

/** The most rows the "In your graph" section shows (the API request's `limit`). */
export const GRAPH_RESULT_LIMIT = 8;

/** A type the `type:` token can name. */
export interface PaletteTypeOption {
  /** The type key the API takes, such as `Person`. */
  key: string;
  /** The label people see, such as `People`. */
  label: string;
}

/** What the input says. */
export interface ParsedPaletteQuery {
  /** The free text, with the `type:` tokens removed and the spaces collapsed. */
  text: string;
  /** The type keys the tokens name, de-duplicated, in the order typed. */
  types: string[];
  /** The values of `type:` tokens that name no known type, as typed. */
  unknownTypes: string[];
}

/**
 * Splits the input into free text and `type:` tokens. A token matches a type's
 * key or its label, ignoring case; `type:` with nothing after it is ignored
 * while the person is still typing it.
 */
export function parsePaletteQuery(raw: string, typeOptions: readonly PaletteTypeOption[]): ParsedPaletteQuery {
  const types: string[] = [];
  const unknownTypes: string[] = [];
  const words: string[] = [];
  for (const word of raw.trim().split(/\s+/)) {
    if (word === '') continue;
    const match = /^type:(.*)$/i.exec(word);
    if (!match) {
      words.push(word);
      continue;
    }
    const value = match[1].trim();
    if (value === '') continue;
    const wanted = value.toLowerCase();
    const found = typeOptions.find((option) => option.key.toLowerCase() === wanted || option.label.toLowerCase() === wanted);
    if (found) {
      if (!types.includes(found.key)) types.push(found.key);
    } else if (!unknownTypes.includes(value)) {
      unknownTypes.push(value);
    }
  }
  return { text: words.join(' '), types, unknownTypes };
}

/**
 * How well `text` matches `label`, or `null` for no match. Case-insensitive; a
 * prefix of the label beats a prefix of a word beats a substring beats an
 * in-order subsequence ("jrn" finds "Joe Rivera N"). Shorter labels rank higher.
 */
export function fuzzyScore(label: string, text: string): number | null {
  const needle = text.trim().toLowerCase();
  if (needle === '') return 0;
  const hay = label.toLowerCase();
  const compactness = Math.min(label.length, 60) / 60;
  if (hay.startsWith(needle)) return 100 - compactness * 10;
  const wordStart = hay.split(/[\s\-_./@]+/).some((word) => word.startsWith(needle));
  if (wordStart) return 80 - compactness * 10;
  if (hay.includes(needle)) return 60 - compactness * 10;
  let at = 0;
  for (const ch of needle) {
    const found = hay.indexOf(ch, at);
    if (found === -1) return null;
    at = found + 1;
  }
  return 30 - compactness * 10;
}

/** One node on the canvas that matches the input. */
export interface CanvasMatch {
  /** The node id. */
  id: string;
  /** The node's label. */
  label: string;
  /** The node's ontology type key. */
  type: string;
}

/**
 * The loaded nodes whose label matches the free text, best first. With type
 * tokens only nodes of those types qualify; a "+N more" stub never does. With
 * neither text nor tokens there is nothing to match, so the section is empty.
 */
export function canvasMatches(
  graph: ExplorerGraph,
  visibleIds: ReadonlySet<string>,
  query: ParsedPaletteQuery,
  limit: number = CANVAS_RESULT_LIMIT,
): CanvasMatch[] {
  if (query.text === '' && query.types.length === 0) return [];
  const scored: { match: CanvasMatch; score: number }[] = [];
  for (const id of visibleIds) {
    if (!graph.hasNode(id)) continue;
    const attrs = graph.getNodeAttributes(id);
    if (attrs.isStub) continue;
    if (query.types.length > 0 && !query.types.includes(attrs.entityType)) continue;
    const score = fuzzyScore(attrs.label, query.text);
    if (score === null) continue;
    scored.push({ match: { id, label: attrs.label, type: attrs.entityType }, score });
  }
  scored.sort((a, b) => b.score - a.score || a.match.label.localeCompare(b.match.label) || a.match.id.localeCompare(b.match.id));
  return scored.slice(0, limit).map((entry) => entry.match);
}

/** What adding or replacing a seed does. */
export type SeedPlan =
  | { kind: 'set'; seedIds: string[] }
  | { kind: 'refused'; message: string };

/** The sentence shown when a seed cannot be added. */
export function seedCapMessage(max: number = MAX_PALETTE_SEEDS): string {
  return `You can start from up to ${max} things. Press Alt+Enter to replace them with this one.`;
}

/**
 * The seeds after adding (`Enter`) or replacing with (`Alt+Enter`) an entity.
 * Adding to a full set is refused with a message; adding what is already a seed
 * changes nothing; replacing always yields exactly that entity.
 */
export function seedPlan(
  current: readonly string[],
  id: string,
  mode: 'add' | 'replace',
  max: number = MAX_PALETTE_SEEDS,
): SeedPlan {
  if (mode === 'replace') return { kind: 'set', seedIds: [id] };
  if (current.includes(id)) return { kind: 'set', seedIds: [...current] };
  if (current.length >= max) return { kind: 'refused', message: seedCapMessage(max) };
  return { kind: 'set', seedIds: [...current, id] };
}

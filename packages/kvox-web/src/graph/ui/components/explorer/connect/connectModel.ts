/**
 * The pure part of "what connects these" (GIC-14, #675): the summary sentence
 * ("3 people, 2 products and 1 risk in common"), the rows of the shared list
 * and the bridge list, and the seeds a notes entry opens the explorer with.
 * No React, no canvas.
 */

import type { GraphConnectPath, GraphConnectResponse } from '../../../../headless/clients/graph.js';

/** The most seeds `?seed=` may carry, and so the most the notes entry seeds the canvas with. */
export const CONNECT_MAX_SEEDS = 10;

const IRREGULAR_PLURALS: Readonly<Record<string, string>> = {
  person: 'people',
  company: 'companies',
  category: 'categories',
};

/**
 * The plural of a type label, lowercased, for the summary sentence: "person" is "people", "risk" is "risks".
 *
 * @param label - The singular label, for example `Person`.
 * @param count - How many; `1` keeps the singular.
 * @returns The noun in lower case.
 *
 * @stability experimental
 */
export function pluralNoun(label: string, count: number): string {
  const noun = label.trim().toLowerCase();
  if (count === 1 || noun === '') return noun;
  const last = noun.split(/\s+/).pop() ?? noun;
  const irregular = IRREGULAR_PLURALS[last];
  if (irregular) return noun.slice(0, noun.length - last.length) + irregular;
  if (/(s|x|z|ch|sh)$/.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

/** "a, b and c". */
function joinList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * One shared entity, ready to list.
 *
 * @stability experimental
 */
export interface SharedRow {
  /** The entity id. */
  entityId: string;
  /** Its label; the id when the slice does not carry it. */
  label: string;
  /** Its entity type key. */
  type: string;
  /** The titles of the inputs that touch it. */
  inputTitles: string[];
  /** How many inputs touch it. */
  coverage: number;
  /** Mentions across those inputs. */
  mentionCount: number;
}

/**
 * The shared entities as list rows, in the API's order (widest coverage, then mentions).
 *
 * @param result - The connect answer.
 * @returns One row per shared entity.
 *
 * @stability experimental
 */
export function sharedRows(result: GraphConnectResponse): SharedRow[] {
  const nodes = new Map(result.slice.nodes.map((node) => [node.id, node]));
  const titles = new Map(result.inputs.map((input) => [input.id, input.title]));
  return result.shared.map((shared) => {
    const node = nodes.get(shared.entityId);
    return {
      entityId: shared.entityId,
      label: node?.label ?? shared.entityId,
      type: node?.type ?? '',
      inputTitles: shared.inputIds.map((id) => titles.get(id) ?? ''),
      coverage: shared.inputIds.length,
      mentionCount: shared.mentionCount,
    };
  });
}

/**
 * "3 people, 2 products and 1 risk in common": the shared entities counted by type, the largest group first.
 *
 * @param result - The connect answer.
 * @param typeLabel - Turns a type key into its singular label.
 * @returns The sentence; "Nothing in common yet" when nothing is shared.
 *
 * @stability experimental
 */
export function summarySentence(result: GraphConnectResponse, typeLabel: (type: string) => string): string {
  const rows = sharedRows(result);
  if (rows.length === 0) return 'Nothing in common yet';
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const parts = groups.map(([type, count]) => `${count} ${pluralNoun(type ? typeLabel(type) : 'entity', count)}`);
  return `${joinList(parts)} in common`;
}

/**
 * The ids the explorer opens with for the connect answer: the shared entities first, then each input's strongest entities in turn, at most {@link CONNECT_MAX_SEEDS} and without repeats.
 *
 * @param result - The connect answer.
 * @returns The seed ids; empty when no input touches any entity.
 *
 * @stability experimental
 */
export function connectSeedIds(result: GraphConnectResponse): string[] {
  const seeds: string[] = [];
  const add = (id: string | undefined): void => {
    if (id && !seeds.includes(id) && seeds.length < CONNECT_MAX_SEEDS) seeds.push(id);
  };
  for (const shared of result.shared) add(shared.entityId);
  for (let rank = 0; seeds.length < CONNECT_MAX_SEEDS; rank += 1) {
    let any = false;
    for (const input of result.inputs) {
      if (rank < input.entityIds.length) {
        any = true;
        add(input.entityIds[rank]);
      }
    }
    if (!any) break;
  }
  return seeds;
}

/**
 * One bridge, ready to list.
 *
 * @stability experimental
 */
export interface BridgeRow {
  /** The bridge, as the API sent it. */
  path: GraphConnectPath;
  /** Title of the input the bridge starts at. */
  fromTitle: string;
  /** Title of the input the bridge ends at. */
  toTitle: string;
  /** The labels of the nodes along it, in walking order. */
  labels: string[];
}

/**
 * The bridges as list rows, with the input titles and the node labels along each.
 *
 * @param result - The connect answer.
 * @returns One row per bridge, best first.
 *
 * @stability experimental
 */
export function bridgeRows(result: GraphConnectResponse): BridgeRow[] {
  const nodes = new Map(result.slice.nodes.map((node) => [node.id, node.label]));
  const titles = new Map(result.inputs.map((input) => [input.id, input.title]));
  return result.paths.map((path) => ({
    path,
    fromTitle: titles.get(path.fromInput) ?? '',
    toTitle: titles.get(path.toInput) ?? '',
    labels: path.nodeIds.map((id) => nodes.get(id) ?? id),
  }));
}

/**
 * The ids the canvas rings: every shared entity.
 *
 * @param result - The connect answer, or `null`.
 * @returns The ids; an empty set without an answer.
 *
 * @stability experimental
 */
export function sharedIdSet(result: GraphConnectResponse | null): ReadonlySet<string> {
  return new Set(result ? result.shared.map((shared) => shared.entityId) : []);
}

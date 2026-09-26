/**
 * What the explorer's filter chips offer, derived from the caller's effective
 * ontology (#374; spec §17.2, §22.2). Pure — no React, no graphology.
 *
 * A NODE TYPE is what a slice node's `type` carries: an entity type key
 * (`Person`) or, for an item, its kind (`commitment`) — exactly the keys
 * `POST /api/graph/explore/expand`'s `types` accepts. A DOMAIN chip is not a
 * filter of its own: it maps to that domain's node and relation types, so the
 * request only ever carries types.
 */

import type { GraphOntology } from '../../../services/graph';
import { humanizeKey } from '../../../utils/graphDisplay';

export interface FilterOption {
  key: string;
  label: string;
  domain: string;
}

export interface DomainOption {
  key: string;
  label: string;
  nodeTypes: string[];
  relationTypes: string[];
}

/** Used until the ontology arrives, and if it never does. */
const FALLBACK_NODE_TYPES: FilterOption[] = [
  { key: 'Person', label: 'People', domain: 'core' },
  { key: 'Organization', label: 'Organizations', domain: 'core' },
  { key: 'Project', label: 'Projects', domain: 'work' },
  { key: 'Meeting', label: 'Meetings', domain: 'work' },
  { key: 'commitment', label: 'Commitments', domain: 'work' },
  { key: 'decision', label: 'Decisions', domain: 'work' },
  { key: 'claim', label: 'Claims', domain: 'core' },
];

export function nodeTypeOptions(ontology: GraphOntology | null): FilterOption[] {
  if (!ontology) return FALLBACK_NODE_TYPES;
  const options: FilterOption[] = [];
  const seen = new Set<string>();
  for (const type of ontology.entityTypes) {
    if (type.deprecated) continue;
    const key = type.storage === 'item' ? type.itemKind : type.key;
    // A sensitive PersonFact never reaches a slice (§5.6); a chip for it would
    // filter nothing. Person facts in general stay on the entity page.
    if (!key || key === 'person_fact' || seen.has(key)) continue;
    seen.add(key);
    options.push({ key, label: type.pluralLabel || type.label, domain: type.domain });
  }
  return options;
}

export function relationTypeOptions(ontology: GraphOntology | null): FilterOption[] {
  if (!ontology) return [];
  return ontology.relationTypes
    .filter((rel) => !rel.deprecated)
    .map((rel) => ({ key: rel.key, label: rel.label || humanizeKey(rel.key), domain: rel.domain }));
}

/**
 * Chips for the caller's ENABLED domains other than the always-on core — hiding
 * `core` would hide People and Organizations, which the type chips already do
 * one by one.
 */
export function domainOptions(ontology: GraphOntology | null): DomainOption[] {
  if (!ontology) return [];
  const nodeTypes = nodeTypeOptions(ontology);
  const relations = relationTypeOptions(ontology);
  return ontology.domains
    .filter((domain) => domain.enabled && !domain.alwaysOn)
    .map((domain) => ({
      key: domain.key,
      label: domain.label,
      nodeTypes: nodeTypes.filter((t) => t.domain === domain.key).map((t) => t.key),
      relationTypes: relations.filter((r) => r.domain === domain.key).map((r) => r.key),
    }))
    .filter((domain) => domain.nodeTypes.length + domain.relationTypes.length > 0);
}

/** A node type's singular label: `Person`, `Commitment`. */
export function nodeTypeLabel(key: string, ontology: GraphOntology | null): string {
  const found = ontology?.entityTypes.find((t) => t.key === key || t.itemKind === key);
  if (found) return found.label;
  return /^[a-z]/.test(key) ? humanizeKey(key) : key;
}

/** Parse `?types=Person,Organization` into the set of HIDDEN types (its complement). */
export function hiddenFromShown(shownParam: string | null, all: readonly string[]): Set<string> {
  if (!shownParam) return new Set();
  const shown = new Set(shownParam.split(',').map((s) => s.trim()).filter(Boolean));
  if (shown.size === 0) return new Set();
  return new Set(all.filter((key) => !shown.has(key)));
}

/** The inverse: `null` when nothing is hidden (the param is dropped). */
export function shownParamFromHidden(hidden: ReadonlySet<string>, all: readonly string[]): string | null {
  if (hidden.size === 0) return null;
  return all.filter((key) => !hidden.has(key)).join(',');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An `as_of` date param: `YYYY-MM-DD`, or null for anything else. */
export function parseAsOfParam(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ? null : value;
}

/** "Mar 2024" for a `YYYY-MM-DD`, read in UTC. */
export function monthLabel(iso: string): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * Pure display helpers for the knowledge-graph pages (#373).
 *
 * Kept out of the components so both the pages and their tests read one
 * definition of "how is a month-precision date written".
 */

import type { DatePrecision, GraphOntology } from '../services/graph';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A date written to the precision it is known to (§5.4): "2026", "Mar 2026",
 * "4 Mar 2026". READ IN UTC — a month-precision date is stored as the first
 * instant of the month in UTC, and a viewer west of Greenwich would otherwise
 * see "Feb 2026" for a fact recorded as March.
 */
export function formatPrecisionDate(iso: string | null, precision: DatePrecision): string {
  if (!iso) return 'Date unknown';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Date unknown';
  const year = date.getUTCFullYear();
  const month = MONTHS[date.getUTCMonth()];
  switch (precision) {
    case 'year':
      return String(year);
    case 'month':
      return `${month} ${year}`;
    case 'unknown':
    case 'day':
    default:
      return `${date.getUTCDate()} ${month} ${year}`;
  }
}

/** `WORKS_FOR` → "Works for". The fallback when the ontology has no label. */
export function humanizeKey(key: string): string {
  const words = key.toLowerCase().split(/[_\s]+/).filter(Boolean);
  if (words.length === 0) return key;
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A relation type's label from the effective schema, else the key humanized. */
export function relationTypeLabel(key: string, ontology: GraphOntology | null): string {
  return ontology?.relationTypes.find((rel) => rel.key === key)?.label ?? humanizeKey(key);
}

/** One displayable relation prop: its ontology label and its formatted value. */
export interface RelationPropDisplay {
  key: string;
  label: string;
  value: string;
}

/**
 * A graph edge's props as label/value pairs, for display (#442) — e.g.
 * `HAS_ROLE {title, businessUnit}` → Role "Managing Director", Business unit
 * "Consulting". Labels and kinds come from the ontology's relation-type
 * `props`, in their declared order; a prop the ontology does not know keeps
 * the API's order and its key humanized. Only primitive values render (an
 * object or array is skipped); a `date` prop is written as a date, a `select`
 * value as its choice label, a boolean as Yes/No. Empty or absent → `[]`.
 */
export function relationPropsDisplay(
  relationType: string,
  props: Record<string, unknown> | null | undefined,
  ontology: GraphOntology | null,
): RelationPropDisplay[] {
  if (!props) return [];
  const defs = ontology?.relationTypes.find((rel) => rel.key === relationType)?.props ?? [];
  const order = new Map(defs.map((def, index) => [def.key, index]));
  const keys = Object.keys(props).sort(
    (a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
  const out: RelationPropDisplay[] = [];
  for (const key of keys) {
    const raw = props[key];
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') continue;
    const def = defs.find((candidate) => candidate.key === key);
    let value: string;
    if (typeof raw === 'boolean') {
      value = raw ? 'Yes' : 'No';
    } else if (def?.kind === 'date' && typeof raw === 'string') {
      value = formatPrecisionDate(raw, 'day');
      if (value === 'Date unknown') value = raw;
    } else if (def?.kind === 'select' && typeof raw === 'string') {
      value = def.options?.choices?.find((choice) => choice.value === raw)?.label ?? raw;
    } else {
      value = String(raw);
    }
    if (value.trim() === '') continue;
    out.push({ key, label: def?.label ?? humanizeKey(key), value });
  }
  return out;
}

/** An entity type's singular label from the effective schema, else the key. */
export function entityTypeLabel(key: string, ontology: GraphOntology | null): string {
  return ontology?.entityTypes.find((type) => type.key === key)?.label ?? key;
}

/** "Joe Rivera" → "JR"; one word → its first two letters. */
export function initials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** The month heading an event groups under: "September 2026", or "Undated". */
export function monthGroupKey(iso: string | null, precision: DatePrecision): string {
  if (!iso) return 'Undated';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Undated';
  if (precision === 'year') return String(date.getUTCFullYear());
  const month = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(date);
  return `${month} ${date.getUTCFullYear()}`;
}

/** The default entity types the index shows (§13: people and organizations first). */
export const DEFAULT_INDEX_TYPES = ['Person', 'Organization'] as const;

/** The entity-storage types the index offers as filters, in registry order. */
export function indexableEntityTypes(ontology: GraphOntology | null): { key: string; label: string; pluralLabel: string }[] {
  if (!ontology) {
    return ['Person', 'Organization', 'Project', 'Meeting'].map((key) => ({
      key,
      label: key,
      pluralLabel: `${key}s`,
    }));
  }
  return ontology.entityTypes
    .filter((type) => type.storage === 'entity' && !type.deprecated)
    .map((type) => ({ key: type.key, label: type.label, pluralLabel: type.pluralLabel }));
}

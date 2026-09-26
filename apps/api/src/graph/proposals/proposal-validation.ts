// =============================================================================
// Proposal payload validation (#366; docs/specs/ontology.md §3.3, §8, §17)
// =============================================================================
//
// PURE. One validator for a proposal row's EFFECTIVE payload, used by the
// review PATCH (an `edit`, a relink, an added row) and again by the commit
// before anything is written — so what the reviewer was allowed to save and
// what the commit is willing to write can never disagree.
//
//   entity    payload schema (#363) → type in the effective schema, stored as
//             an entity, not retired → closed props (#350)
//   relation  payload schema → type stored as an edge → closed props →
//             temporal fields → both endpoints of a permitted type
//   item      payload schema (`statementHash` recomputed, never trusted) →
//             the item type for `kind` → closed props → status → subject /
//             owner / counterparty / meeting of a permitted type → temporal
//
// Endpoint TYPES come from the caller (`typeOf`): a `{ ref }` resolves to the
// proposal row's own effective type, an `{ entityId }` to the committed
// entity's. Whether a ref'd row is ACCEPTED is the commit's question, not
// this one's.
//
// Issues are `{ path, message, code? }` — the shape `validateProps` already
// returns — so the web maps every one of them onto a field the same way.
// =============================================================================

import type { EffectiveEntityType, EffectiveSchema, ValidPrecision } from '@app/shared/ontology';
import { validateProps } from '@app/shared/ontology';
import type { z } from 'zod';

import { rangeFromPrecision, TemporalInputError, type ValidRange } from '../temporal';
import { statementHash } from '../write/normalize';
import {
  entityPayloadSchema,
  itemPayloadSchema,
  relationPayloadSchema,
  type EndpointRef,
  type EntityPayload,
  type ItemPayload,
  type RelationPayload,
} from './proposal-payload.schema';

export interface PayloadIssue {
  path: string;
  message: string;
  code?: string;
}

export type PayloadValidation<T> = { ok: true; value: T } | { ok: false; issues: PayloadIssue[] };

/** An endpoint's entity type, or `undefined` when it names nothing that exists. */
export type EndpointTypeOf = (endpoint: EndpointRef) => string | undefined;

function zodIssues(error: z.ZodError): PayloadIssue[] {
  return error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message, code: i.code }));
}

function propsIssues(issues: { path: string; message: string }[]): PayloadIssue[] {
  return issues.map((i) => ({ path: i.path ? `props.${i.path}` : 'props', message: i.message }));
}

/** The item type key an item `kind` is stored as (`commitment` → `Commitment`). */
export function itemTypeFor(schema: EffectiveSchema, kind: string): EffectiveEntityType | undefined {
  const matches = schema.entityTypes.filter((t) => t.storage === 'item' && t.itemKind === kind);
  return matches.find((t) => !t.deprecated) ?? matches[0];
}

// -----------------------------------------------------------------------------
// Temporal
// -----------------------------------------------------------------------------

function atPrecision(iso: string, precision: 'day' | 'month' | 'year'): string {
  return precision === 'year' ? iso.slice(0, 4) : precision === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
}

export interface CommittedValidity {
  valid: ValidRange | null;
  validPrecision: ValidPrecision | null;
}

/**
 * A payload's `validFrom`/`validTo`/`precision` as the `valid` column takes
 * it. `temporal: false` → no range and no precision. `unknown`, or no bound →
 * `unknown` with no range (§5.4: never guess). `openEnded` turns a start-only
 * statement into a continuing state (`[from, )`) rather than a point — the
 * reading a normally-exclusive relation (`WORKS_FOR`, `HAS_ROLE`) needs.
 * Throws `TemporalInputError`.
 */
export function committedValidity(
  payload: { validFrom: string | null; validTo: string | null; precision: ValidPrecision },
  opts: { temporal: boolean; openEnded: boolean },
): CommittedValidity {
  if (!opts.temporal) return { valid: null, validPrecision: null };
  const { validFrom, validTo, precision } = payload;
  if (precision === 'unknown' || (validFrom === null && validTo === null)) {
    return { valid: null, validPrecision: 'unknown' };
  }
  const { range } = rangeFromPrecision(
    validFrom === null ? null : atPrecision(validFrom, precision),
    validTo === null ? null : atPrecision(validTo, precision),
    precision,
    { openEnded: opts.openEnded && validTo === null },
  );
  return { valid: range, validPrecision: precision };
}

function temporalIssues(
  payload: { validFrom: string | null; validTo: string | null; precision: ValidPrecision },
  temporal: boolean,
  openEnded: boolean,
): PayloadIssue[] {
  if (!temporal) {
    return payload.validFrom !== null || payload.validTo !== null
      ? [{ path: 'validFrom', message: 'This relation is not time-bounded; send no dates.' }]
      : [];
  }
  try {
    committedValidity(payload, { temporal, openEnded });
    return [];
  } catch (err) {
    if (err instanceof TemporalInputError) return [{ path: 'validTo', message: err.message }];
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Entities
// -----------------------------------------------------------------------------

export function validateEntityPayload(raw: unknown, schema: EffectiveSchema): PayloadValidation<EntityPayload> {
  const parsed = entityPayloadSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const value = parsed.data;
  const type = schema.entityType(value.type);
  if (!type || type.storage !== 'entity') {
    return { ok: false, issues: [{ path: 'type', message: `'${value.type}' is not an entity type in your graph.` }] };
  }
  if (type.deprecated) {
    return { ok: false, issues: [{ path: 'type', message: `'${value.type}' is retired and takes no new entities.` }] };
  }
  const props = validateProps(schema, value.type, value.props);
  if (!props.ok) return { ok: false, issues: propsIssues(props.issues) };
  return { ok: true, value: { ...value, props: props.value } };
}

// -----------------------------------------------------------------------------
// Relations
// -----------------------------------------------------------------------------

/** Whether a start-only relation of this type is a continuing state. */
export function relationIsOpenEnded(schema: EffectiveSchema, type: string): boolean {
  const spec = schema.relationType(type);
  return !!spec && spec.temporal && spec.exclusive === 'soft';
}

export function validateRelationPayload(
  raw: unknown,
  schema: EffectiveSchema,
  typeOf: EndpointTypeOf,
): PayloadValidation<RelationPayload> {
  const parsed = relationPayloadSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const value = parsed.data;
  const spec = schema.relationType(value.type);
  if (!spec || spec.representation.kind !== 'edge') {
    return { ok: false, issues: [{ path: 'type', message: `'${value.type}' is not a relation type you can add.` }] };
  }
  if (spec.deprecated) {
    return { ok: false, issues: [{ path: 'type', message: `'${value.type}' is retired and takes no new relations.` }] };
  }
  const issues: PayloadIssue[] = [];
  const props = validateProps(schema, value.type, value.props, { relation: true });
  if (!props.ok) issues.push(...propsIssues(props.issues));
  issues.push(...temporalIssues(value, spec.temporal, relationIsOpenEnded(schema, value.type)));

  const fromType = typeOf(value.from);
  const toType = typeOf(value.to);
  if (fromType === undefined) issues.push({ path: 'from', message: 'The source is not an entity in this proposal or your graph.', code: 'endpoint_gone' });
  else if (!spec.from.includes(fromType)) issues.push({ path: 'from', message: `'${value.type}' cannot start from a ${fromType}.` });
  if (toType === undefined) issues.push({ path: 'to', message: 'The target is not an entity in this proposal or your graph.', code: 'endpoint_gone' });
  else if (!spec.to.includes(toType)) issues.push({ path: 'to', message: `'${value.type}' cannot point at a ${toType}.` });
  if (
    fromType !== undefined &&
    toType !== undefined &&
    spec.allowedPairs &&
    !spec.allowedPairs.some(([a, b]) => a === fromType && b === toType)
  ) {
    issues.push({ path: 'to', message: `'${value.type}' does not connect a ${fromType} to a ${toType}.` });
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { ...value, props: props.ok ? props.value : value.props } };
}

// -----------------------------------------------------------------------------
// Items
// -----------------------------------------------------------------------------

const ITEM_COLUMNS = [
  { field: 'owner', column: 'owner_person_id' },
  { field: 'counterparty', column: 'counterparty_id' },
  { field: 'meeting', column: 'meeting_id' },
] as const;

/** The entity types an item type's owner/counterparty/meeting column may name. */
export function itemColumnTypes(schema: EffectiveSchema, itemTypeKey: string, column: string): string[] {
  return schema.relationTypes
    .filter(
      (r) =>
        r.representation.kind === 'item_column' &&
        (r.representation as { column: string }).column === column &&
        r.from.includes(itemTypeKey),
    )
    .flatMap((r) => [...r.to]);
}

export function validateItemPayload(
  raw: unknown,
  schema: EffectiveSchema,
  typeOf: EndpointTypeOf,
): PayloadValidation<ItemPayload> {
  // The hash is derived, never trusted from a client: recompute it first.
  const input = { ...(raw as Record<string, unknown>) };
  if (typeof input.kind === 'string' && typeof input.statement === 'string') {
    input.statementHash = statementHash(input.kind as ItemPayload['kind'], input.statement.trim());
  }
  const parsed = itemPayloadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const value = parsed.data;

  const type = itemTypeFor(schema, value.kind);
  if (!type) return { ok: false, issues: [{ path: 'kind', message: `'${value.kind}' is not an item type in your graph.` }] };
  if (type.deprecated) return { ok: false, issues: [{ path: 'kind', message: `'${type.key}' is retired and takes no new items.` }] };

  const issues: PayloadIssue[] = [];
  const props = validateProps(schema, type.key, value.props);
  if (!props.ok) issues.push(...propsIssues(props.issues));
  if (value.status !== null && !(type.statuses ?? []).includes(value.status)) {
    issues.push({ path: 'status', message: `'${value.status}' is not a status of ${type.key}.` });
  }
  if (value.kind === 'person_fact' && value.sensitivity === null) {
    issues.push({ path: 'sensitivity', message: 'A person fact needs a sensitivity.' });
  }
  if (value.kind !== 'person_fact' && value.sensitivity !== null) {
    issues.push({ path: 'sensitivity', message: 'Only a person fact carries a sensitivity.' });
  }

  const subjectRequired = type.subjectRequired || value.kind === 'claim' || value.kind === 'person_fact';
  if (value.subject === null) {
    if (subjectRequired) issues.push({ path: 'subject', message: `A ${type.key} needs a subject.` });
  } else {
    const t = typeOf(value.subject);
    if (t === undefined) issues.push({ path: 'subject', message: 'The subject is not an entity in this proposal or your graph.', code: 'endpoint_gone' });
    else if (!(type.subjectTypes ?? []).includes(t)) issues.push({ path: 'subject', message: `A ${type.key}'s subject cannot be a ${t}.` });
  }
  for (const { field, column } of ITEM_COLUMNS) {
    const endpoint = value[field];
    if (endpoint === null) continue;
    const allowed = itemColumnTypes(schema, type.key, column);
    const t = typeOf(endpoint);
    if (allowed.length === 0) issues.push({ path: field, message: `A ${type.key} has no ${field}.` });
    else if (t === undefined) issues.push({ path: field, message: `The ${field} is not an entity in this proposal or your graph.`, code: 'endpoint_gone' });
    else if (!allowed.includes(t)) issues.push({ path: field, message: `A ${type.key}'s ${field} cannot be a ${t}.` });
  }
  issues.push(...temporalIssues(value, true, false));

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { ...value, props: props.ok ? props.value : value.props } };
}

/** The endpoints a relation/item payload names, by relink field. */
export function endpointsOf(kind: 'relation' | 'item', payload: Record<string, unknown>): Array<{ field: string; endpoint: EndpointRef }> {
  const fields = kind === 'relation' ? ['from', 'to'] : ['subject', 'owner', 'counterparty', 'meeting'];
  return fields.flatMap((field) => {
    const v = payload[field];
    return v !== null && typeof v === 'object' ? [{ field, endpoint: v as EndpointRef }] : [];
  });
}

// =============================================================================
// The definition factories: `defineEntityType`, `defineRelationType`,
// `defineDomain` (docs/specs/ontology.md §17.1).
//
// Every check here runs when a domain module is LOADED, so a malformed
// declaration fails the first `require('@app/shared/ontology')` — in every API
// test, every web test and at API boot — rather than surfacing later as a
// strange extraction prompt. Cross-type checks (dangling endpoints, duplicate
// keys across modules, mixin targets) need every module at once and live in
// `registry.ts`.
//
// Each factory returns a deep-frozen COPY: a consumer mutating a spec it was
// handed can never change what another consumer reads.
// =============================================================================

import {
  ATTRIBUTE_KEY_PATTERN,
  ATTRIBUTE_KINDS,
  DOMAIN_KEYS,
  ENTITY_TYPE_KEY_PATTERN,
  ITEM_KINDS,
  RELATION_TYPE_KEY_PATTERN,
  SENSITIVITIES,
  USER_ATTRIBUTE_KEY_PREFIX,
} from './constants.js';
import type {
  AttributeOptions,
  AttributeSpec,
  DomainModule,
  EntityTypeSpec,
  RelationTypeSpec,
} from './types.js';

/** Thrown for any ontology declaration that breaks a definition rule. */
export class OntologyDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OntologyDefinitionError';
  }
}

const REPRESENTATION_KINDS = ['edge', 'item_column', 'speaker_link', 'mention', 'evidence', 'supersedes'];
const ITEM_COLUMNS = ['subject_id', 'owner_person_id', 'counterparty_id', 'meeting_id'];

function fail(where: string, rule: string): never {
  throw new OntologyDefinitionError(`${where}: ${rule}`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireText(where: string, field: string, value: unknown): void {
  if (!isNonEmptyString(value)) fail(where, `${field} must be a non-empty string`);
}

function includes(list: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && list.includes(value);
}

/** Validates per-kind options; shared with user attribute defs. */
export function checkAttributeOptions(where: string, kind: string, options: AttributeOptions | null | undefined): void {
  if (kind === 'select' || kind === 'multi_select') {
    const choices = options?.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      fail(where, `a ${kind} attribute must declare at least one choice`);
    }
    const seen = new Set<string>();
    for (const choice of choices) {
      if (!isNonEmptyString(choice?.value)) fail(where, 'every choice needs a non-empty value');
      if (!isNonEmptyString(choice?.label)) fail(where, `choice '${choice.value}' needs a non-empty label`);
      if (seen.has(choice.value)) fail(where, `choice value '${choice.value}' is declared twice`);
      seen.add(choice.value);
    }
  } else if (options?.choices !== undefined) {
    fail(where, `choices are only valid on select/multi_select, not ${kind}`);
  }
  if (options?.targetTypes !== undefined) {
    if (kind !== 'entity_ref') fail(where, `targetTypes are only valid on entity_ref, not ${kind}`);
    if (!Array.isArray(options.targetTypes) || options.targetTypes.length === 0) {
      fail(where, 'targetTypes, when given, must be a non-empty list');
    }
    for (const t of options.targetTypes) {
      if (!ENTITY_TYPE_KEY_PATTERN.test(t)) fail(where, `target type '${t}' is not a type key`);
    }
  }
}

function checkAttributes(owner: string, attributes: Record<string, AttributeSpec> | undefined, field: string): void {
  if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) {
    fail(owner, `${field} must be an object (use {} for none)`);
  }
  for (const [key, spec] of Object.entries(attributes)) {
    const where = `${owner}.${key}`;
    if (key.startsWith(USER_ATTRIBUTE_KEY_PREFIX)) {
      fail(where, `attribute keys may not start with '${USER_ATTRIBUTE_KEY_PREFIX}' (reserved for user attributes)`);
    }
    if (!ATTRIBUTE_KEY_PATTERN.test(key)) fail(where, `attribute key must match ${ATTRIBUTE_KEY_PATTERN}`);
    if (spec === null || typeof spec !== 'object') fail(where, 'attribute spec must be an object');
    if (!includes(ATTRIBUTE_KINDS, spec.kind)) {
      fail(where, `kind must be one of ${ATTRIBUTE_KINDS.join(', ')} (got ${String(spec.kind)})`);
    }
    requireText(where, 'label', spec.label);
    requireText(where, 'description', spec.description);
    if (spec.sensitivity !== undefined && !includes(SENSITIVITIES, spec.sensitivity)) {
      fail(where, `sensitivity must be one of ${SENSITIVITIES.join(', ')}`);
    }
    if (spec.kind === 'multi_select' && spec.list) {
      fail(where, 'multi_select is already a list; do not also set list: true');
    }
    checkAttributeOptions(where, spec.kind, spec.options);
    if (spec.deprecated !== undefined) checkDeprecation(where, spec.deprecated);
  }
}

function checkDeprecation(where: string, deprecated: { since: string; reason: string }): void {
  requireText(where, 'deprecated.since', deprecated?.since);
  requireText(where, 'deprecated.reason', deprecated?.reason);
}

function checkDomain(where: string, domain: unknown): void {
  if (!includes(DOMAIN_KEYS, domain)) fail(where, `domain must be one of ${DOMAIN_KEYS.join(', ')}`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** A structural deep copy of plain declaration data (no functions, no dates). */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function defineEntityType(spec: EntityTypeSpec): Readonly<EntityTypeSpec> {
  const key = spec?.key;
  const where = `entity type ${String(key)}`;
  if (typeof key !== 'string' || !ENTITY_TYPE_KEY_PATTERN.test(key)) {
    fail(where, `key must match ${ENTITY_TYPE_KEY_PATTERN}`);
  }
  checkDomain(where, spec.domain);
  requireText(where, 'label', spec.label);
  requireText(where, 'pluralLabel', spec.pluralLabel);
  requireText(where, 'description', spec.description);
  if (!Array.isArray(spec.disambiguation) || spec.disambiguation.length === 0) {
    fail(where, 'at least one disambiguation rule is required');
  }
  spec.disambiguation.forEach((rule, i) => requireText(where, `disambiguation[${i}]`, rule));
  if (!includes(SENSITIVITIES, spec.sensitivityDefault)) {
    fail(where, `sensitivityDefault must be one of ${SENSITIVITIES.join(', ')}`);
  }
  checkAttributes(where, spec.attributes, 'attributes');

  if (spec.itemKind !== undefined) {
    if (!includes(ITEM_KINDS, spec.itemKind)) fail(where, `itemKind must be one of ${ITEM_KINDS.join(', ')}`);
    if (!Array.isArray(spec.statuses) || spec.statuses.length === 0) {
      fail(where, 'an item type must declare at least one status');
    }
    if (new Set(spec.statuses).size !== spec.statuses.length) fail(where, 'statuses must be unique');
    spec.statuses.forEach((s, i) => requireText(where, `statuses[${i}]`, s));
    if (!Array.isArray(spec.subjectTypes) || spec.subjectTypes.length === 0) {
      fail(where, 'an item type must declare at least one subject type');
    }
    for (const t of spec.subjectTypes) {
      if (!ENTITY_TYPE_KEY_PATTERN.test(t)) fail(where, `subject type '${t}' is not a type key`);
    }
  } else if (spec.statuses !== undefined || spec.subjectTypes !== undefined || spec.subjectRequired !== undefined) {
    fail(where, 'statuses/subjectTypes/subjectRequired are only valid on item types (set itemKind)');
  }
  if (spec.deprecated !== undefined) checkDeprecation(where, spec.deprecated);

  return deepFreeze(clone(spec));
}

export function defineRelationType(spec: RelationTypeSpec): Readonly<RelationTypeSpec> {
  const key = spec?.key;
  const where = `relation type ${String(key)}`;
  if (typeof key !== 'string' || !RELATION_TYPE_KEY_PATTERN.test(key)) {
    fail(where, `key must match ${RELATION_TYPE_KEY_PATTERN}`);
  }
  checkDomain(where, spec.domain);
  requireText(where, 'label', spec.label);
  requireText(where, 'description', spec.description);

  for (const side of ['from', 'to'] as const) {
    const list = spec[side];
    if (!Array.isArray(list) || list.length === 0) fail(where, `${side} must list at least one endpoint type`);
    for (const t of list) {
      if (!ENTITY_TYPE_KEY_PATTERN.test(t)) fail(where, `${side} endpoint '${t}' is not a type key`);
    }
    if (new Set(list).size !== list.length) fail(where, `${side} lists an endpoint twice`);
  }
  if (spec.allowedPairs !== undefined) {
    if (!Array.isArray(spec.allowedPairs) || spec.allowedPairs.length === 0) {
      fail(where, 'allowedPairs, when given, must be a non-empty list');
    }
    for (const pair of spec.allowedPairs) {
      if (!Array.isArray(pair) || pair.length !== 2) fail(where, 'every allowed pair is a [from, to] tuple');
      if (!spec.from.includes(pair[0]) || !spec.to.includes(pair[1])) {
        fail(where, `allowed pair [${pair.join(', ')}] is not within from × to`);
      }
    }
  }
  if (typeof spec.temporal !== 'boolean') fail(where, 'temporal must be a boolean');
  if (spec.exclusive !== 'soft' && spec.exclusive !== 'none') fail(where, "exclusive must be 'soft' or 'none'");
  if (spec.exclusive === 'soft' && !spec.temporal) fail(where, "exclusive: 'soft' requires temporal: true");
  if (spec.exclusiveScope !== undefined && spec.exclusiveScope !== 'from' && spec.exclusiveScope !== 'from_to') {
    fail(where, "exclusiveScope must be 'from' or 'from_to'");
  }
  if (spec.exclusiveScope !== undefined && spec.exclusive !== 'soft') {
    fail(where, "exclusiveScope only applies to exclusive: 'soft'");
  }
  const rep = spec.representation;
  if (rep === null || typeof rep !== 'object' || !REPRESENTATION_KINDS.includes(rep.kind)) {
    fail(where, `representation.kind must be one of ${REPRESENTATION_KINDS.join(', ')}`);
  }
  if (rep.kind === 'item_column' && !ITEM_COLUMNS.includes(rep.column)) {
    fail(where, `representation.column must be one of ${ITEM_COLUMNS.join(', ')}`);
  }
  if (spec.temporal && rep.kind !== 'edge') fail(where, "a temporal relation must be represented as an 'edge'");
  if (typeof spec.extractable !== 'boolean') fail(where, 'extractable must be a boolean');
  if (spec.extractable && rep.kind !== 'edge') fail(where, "only an 'edge' relation can be extractable");
  checkAttributes(where, spec.props, 'props');
  if (spec.deprecated !== undefined) checkDeprecation(where, spec.deprecated);

  return deepFreeze(clone(spec));
}

export function defineDomain(mod: DomainModule): Readonly<DomainModule> {
  const where = `domain ${String(mod?.key)}`;
  checkDomain(where, mod?.key);
  requireText(where, 'label', mod.label);
  if (typeof mod.alwaysOn !== 'boolean' || typeof mod.defaultEnabled !== 'boolean') {
    fail(where, 'alwaysOn and defaultEnabled must be booleans');
  }
  if (mod.alwaysOn && !mod.defaultEnabled) fail(where, 'an always-on domain must also be enabled by default');
  if (!Array.isArray(mod.entityTypes) || !Array.isArray(mod.relationTypes) || !Array.isArray(mod.mixins)) {
    fail(where, 'entityTypes, relationTypes and mixins must be arrays');
  }
  // Re-run the factories: a module may be handed raw specs, and this is
  // idempotent for already-defined ones.
  const entityTypes = mod.entityTypes.map((t) => defineEntityType(t));
  const relationTypes = mod.relationTypes.map((r) => defineRelationType(r));
  for (const t of entityTypes) {
    if (t.domain !== mod.key) fail(`entity type ${t.key}`, `declared in domain '${mod.key}' but names '${t.domain}'`);
  }
  for (const r of relationTypes) {
    if (r.domain !== mod.key) fail(`relation type ${r.key}`, `declared in domain '${mod.key}' but names '${r.domain}'`);
  }
  for (const mixin of mod.mixins) {
    if (typeof mixin?.entityType !== 'string' || !ENTITY_TYPE_KEY_PATTERN.test(mixin.entityType)) {
      fail(where, `mixin target '${String(mixin?.entityType)}' is not a type key`);
    }
    checkAttributes(`${where} mixin on ${mixin.entityType}`, mixin.attributes, 'attributes');
  }
  return deepFreeze({ ...clone(mod), entityTypes, relationTypes } as DomainModule);
}

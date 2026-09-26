// =============================================================================
// Definition factories (issue #350, docs/specs/ontology.md §17.1)
// =============================================================================
//
// `defineEntityType`, `defineRelationType` and `defineDomain` validate a
// declaration the moment its module loads and return it deeply frozen. A bad
// definition therefore fails at import time -- in every test run, every boot
// -- rather than on the first extraction that happens to reach it.
//
// These checks are LOCAL to one declaration (formats, non-empty copy,
// internal consistency). Cross-declaration checks (duplicate keys, dangling
// endpoints, mixin collisions) need every module at once and live in
// `buildOntologyRegistry()` (`registry.ts`).
// =============================================================================

import {
  ATTRIBUTE_KINDS,
  DOMAIN_KEYS,
  ITEM_KINDS,
  SENSITIVITIES,
  USER_ATTRIBUTE_KEY_PREFIX,
} from './constants.js';
import type {
  AttributeSpec,
  DomainModule,
  EntityTypeSpec,
  RelationRepresentation,
  RelationTypeSpec,
} from './types.js';

/** Thrown for any ontology declaration that breaks a rule. Names the key. */
export class OntologyDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OntologyDefinitionError';
  }
}

export const ENTITY_TYPE_KEY_PATTERN = /^[A-Z][A-Za-z]+$/;
export const RELATION_TYPE_KEY_PATTERN = /^[A-Z][A-Z_]+$/;
export const ATTRIBUTE_KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;

const REPRESENTATION_KINDS = ['edge', 'item_column', 'speaker_link', 'mention', 'evidence', 'supersedes'];
const ITEM_COLUMNS = ['subject_id', 'owner_person_id', 'counterparty_id', 'meeting_id'];

function fail(message: string): never {
  throw new OntologyDefinitionError(message);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function includes(list: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && list.includes(value);
}

/** Recursively freezes a plain-data declaration. */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

/**
 * Validates one attribute declaration (built-in, mixin or relation prop).
 * `owner` is the `Type.attr` / `RELATION.prop` name used in every message.
 */
export function assertAttributeSpec(owner: string, key: string, spec: AttributeSpec): void {
  const name = `${owner}.${key}`;
  if (key.startsWith(USER_ATTRIBUTE_KEY_PREFIX)) {
    fail(`${name}: attribute keys starting '${USER_ATTRIBUTE_KEY_PREFIX}' are reserved for user-defined attributes`);
  }
  if (!ATTRIBUTE_KEY_PATTERN.test(key)) {
    fail(`${name}: attribute key must match ${String(ATTRIBUTE_KEY_PATTERN)} (camelCase)`);
  }
  if (spec === null || typeof spec !== 'object') {
    fail(`${name}: attribute declaration must be an object`);
  }
  if (!includes(ATTRIBUTE_KINDS, spec.kind)) {
    fail(`${name}: kind must be one of ${ATTRIBUTE_KINDS.join(', ')} (got ${String(spec.kind)})`);
  }
  if (!isNonEmptyString(spec.label)) fail(`${name}: label must not be empty`);
  if (!isNonEmptyString(spec.description)) fail(`${name}: description must not be empty`);
  if (spec.sensitivity !== undefined && !includes(SENSITIVITIES, spec.sensitivity)) {
    fail(`${name}: sensitivity must be one of ${SENSITIVITIES.join(', ')}`);
  }
  if (spec.kind === 'select' || spec.kind === 'multi_select') {
    const choices = spec.options?.choices ?? [];
    if (choices.length === 0) fail(`${name}: a ${spec.kind} attribute needs at least one choice`);
    const seen = new Set<string>();
    for (const choice of choices) {
      if (!isNonEmptyString(choice.value)) fail(`${name}: every choice needs a non-empty value`);
      if (!isNonEmptyString(choice.label)) fail(`${name}: choice '${choice.value}' needs a non-empty label`);
      if (seen.has(choice.value)) fail(`${name}: duplicate choice value '${choice.value}'`);
      seen.add(choice.value);
    }
  } else if (spec.options?.choices !== undefined) {
    fail(`${name}: only select and multi_select attributes take choices`);
  }
  if (spec.options?.targetTypes !== undefined) {
    if (spec.kind !== 'entity_ref') fail(`${name}: only entity_ref attributes take targetTypes`);
    if (spec.options.targetTypes.length === 0) fail(`${name}: targetTypes, when given, must not be empty`);
  }
  if (spec.kind === 'multi_select' && spec.list === true) {
    fail(`${name}: multi_select is already a list; do not also set list: true`);
  }
  if (spec.deprecated !== undefined) {
    if (!isNonEmptyString(spec.deprecated.since) || !isNonEmptyString(spec.deprecated.reason)) {
      fail(`${name}: deprecated needs both since and reason`);
    }
  }
}

function assertAttributes(owner: string, attributes: Record<string, AttributeSpec>): void {
  if (attributes === null || typeof attributes !== 'object') {
    fail(`${owner}: attributes must be an object`);
  }
  for (const [key, spec] of Object.entries(attributes)) {
    assertAttributeSpec(owner, key, spec);
  }
}

function assertRepresentation(key: string, representation: RelationRepresentation): void {
  if (representation === null || typeof representation !== 'object' || !includes(REPRESENTATION_KINDS, representation.kind)) {
    fail(`${key}: representation.kind must be one of ${REPRESENTATION_KINDS.join(', ')}`);
  }
  if (representation.kind === 'item_column' && !includes(ITEM_COLUMNS, representation.column)) {
    fail(`${key}: item_column representation needs a column in ${ITEM_COLUMNS.join(', ')}`);
  }
}

export function defineEntityType(spec: EntityTypeSpec): Readonly<EntityTypeSpec> {
  const key = spec?.key;
  if (!isNonEmptyString(key) || !ENTITY_TYPE_KEY_PATTERN.test(key)) {
    fail(`Entity type '${String(key)}': key must match ${String(ENTITY_TYPE_KEY_PATTERN)} (PascalCase)`);
  }
  if (!includes(DOMAIN_KEYS, spec.domain)) fail(`${key}: domain must be one of ${DOMAIN_KEYS.join(', ')}`);
  if (!isNonEmptyString(spec.label)) fail(`${key}: label must not be empty`);
  if (!isNonEmptyString(spec.pluralLabel)) fail(`${key}: pluralLabel must not be empty`);
  if (!isNonEmptyString(spec.description)) fail(`${key}: description must not be empty`);
  if (!Array.isArray(spec.disambiguation) || spec.disambiguation.length === 0) {
    fail(`${key}: needs at least one disambiguation rule`);
  }
  if (!spec.disambiguation.every(isNonEmptyString)) fail(`${key}: disambiguation rules must not be empty`);
  if (!includes(SENSITIVITIES, spec.sensitivityDefault)) {
    fail(`${key}: sensitivityDefault must be one of ${SENSITIVITIES.join(', ')}`);
  }
  assertAttributes(key, spec.attributes);

  if (spec.itemKind !== undefined) {
    if (!includes(ITEM_KINDS, spec.itemKind)) fail(`${key}: itemKind must be one of ${ITEM_KINDS.join(', ')}`);
    if (!Array.isArray(spec.statuses) || spec.statuses.length === 0) fail(`${key}: an item type needs statuses`);
    if (new Set(spec.statuses).size !== spec.statuses.length) fail(`${key}: duplicate status`);
    if (!Array.isArray(spec.subjectTypes) || spec.subjectTypes.length === 0) {
      fail(`${key}: an item type needs subjectTypes`);
    }
    if (typeof spec.subjectRequired !== 'boolean') fail(`${key}: an item type must state subjectRequired`);
  } else if (spec.statuses !== undefined || spec.subjectTypes !== undefined || spec.subjectRequired !== undefined) {
    fail(`${key}: statuses, subjectTypes and subjectRequired are for item types (itemKind) only`);
  }
  return deepFreeze(spec);
}

export function defineRelationType(spec: RelationTypeSpec): Readonly<RelationTypeSpec> {
  const key = spec?.key;
  if (!isNonEmptyString(key) || !RELATION_TYPE_KEY_PATTERN.test(key)) {
    fail(`Relation type '${String(key)}': key must match ${String(RELATION_TYPE_KEY_PATTERN)} (SCREAMING_SNAKE)`);
  }
  if (!includes(DOMAIN_KEYS, spec.domain)) fail(`${key}: domain must be one of ${DOMAIN_KEYS.join(', ')}`);
  if (!isNonEmptyString(spec.label)) fail(`${key}: label must not be empty`);
  if (!isNonEmptyString(spec.description)) fail(`${key}: description must not be empty`);
  if (!Array.isArray(spec.from) || spec.from.length === 0) fail(`${key}: from must name at least one endpoint type`);
  if (!Array.isArray(spec.to) || spec.to.length === 0) fail(`${key}: to must name at least one endpoint type`);
  if (!spec.from.every(isNonEmptyString) || !spec.to.every(isNonEmptyString)) {
    fail(`${key}: endpoint type names must not be empty`);
  }
  if (spec.exclusive !== 'soft' && spec.exclusive !== 'none') fail(`${key}: exclusive must be 'soft' or 'none'`);
  if (spec.exclusive === 'soft' && spec.temporal !== true) {
    fail(`${key}: exclusive 'soft' requires temporal (§5.4's closing rule needs a valid range to close)`);
  }
  if (spec.exclusiveScope !== undefined && spec.exclusiveScope !== 'from' && spec.exclusiveScope !== 'from_to') {
    fail(`${key}: exclusiveScope must be 'from' or 'from_to'`);
  }
  if (spec.exclusiveScope !== undefined && spec.exclusive !== 'soft') {
    fail(`${key}: exclusiveScope only applies to an exclusive relation`);
  }
  assertRepresentation(key, spec.representation);
  if (spec.temporal && spec.representation.kind !== 'edge') {
    fail(`${key}: a temporal relation must be represented as an edge (only kg_relations carries a valid range)`);
  }
  if (spec.extractable && spec.representation.kind !== 'edge') {
    fail(`${key}: only an edge relation can be extractable`);
  }
  if (spec.allowedPairs !== undefined) {
    if (spec.allowedPairs.length === 0) fail(`${key}: allowedPairs, when given, must not be empty`);
    for (const [from, to] of spec.allowedPairs) {
      if (!spec.from.includes(from) || !spec.to.includes(to)) {
        fail(`${key}: allowed pair [${from}, ${to}] is not within from x to`);
      }
    }
  }
  assertAttributes(key, spec.props);
  return deepFreeze(spec);
}

export function defineDomain(mod: DomainModule): Readonly<DomainModule> {
  const key = mod?.key;
  if (!includes(DOMAIN_KEYS, key)) fail(`Domain '${String(key)}': key must be one of ${DOMAIN_KEYS.join(', ')}`);
  if (!isNonEmptyString(mod.label)) fail(`Domain ${key}: label must not be empty`);
  if (mod.alwaysOn && !mod.defaultEnabled) fail(`Domain ${key}: an always-on domain must also be default-enabled`);

  const seen = new Set<string>();
  for (const type of [...mod.entityTypes, ...mod.relationTypes]) {
    if (type.domain !== key) fail(`${type.key}: declared in domain module '${key}' but says domain '${type.domain}'`);
    if (seen.has(type.key)) fail(`Domain ${key}: duplicate key '${type.key}'`);
    seen.add(type.key);
  }
  for (const mixin of mod.mixins) {
    if (!isNonEmptyString(mixin.entityType)) fail(`Domain ${key}: a mixin needs an entityType`);
    assertAttributes(mixin.entityType, mixin.attributes);
  }
  return deepFreeze(mod);
}

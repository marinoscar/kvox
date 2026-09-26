// =============================================================================
// The effective schema (docs/specs/ontology.md §17.2–§17.4): what ONE user's
// graph actually consists of.
//
//   core ∪ {their enabled domains}
//     + the mixins those domains add onto other domains' types
//     + their own `kg_attribute_defs` rows (passed in as plain data)
//     with every relation endpoint and item subject pruned to types present.
//
// It is computed, never hand-assembled per caller, and it is the ONLY input to
// the props validators and JSON Schema builders: a user who disabled `work`
// can never have a `work` type validated or sent to the model for them.
//
// `toEffectiveSchemaPayload` is exactly what `GET /api/graph/ontology` returns
// and what every web form renders from.
// =============================================================================

import {
  ATTRIBUTE_KINDS,
  PSEUDO_TYPES,
  SENSITIVITIES,
  USER_ATTRIBUTE_KEY_PATTERN,
} from './constants.js';
import { checkAttributeOptions, OntologyDefinitionError } from './define.js';
import type { OntologyRegistry } from './registry.js';
import type {
  AttributeKind,
  AttributeOptions,
  AttributeSpec,
  DomainKey,
  KgItemKind,
  RelationRepresentation,
  Sensitivity,
  UserAttributeDef,
} from './types.js';

export interface EffectiveAttributePayload {
  key: string;
  label: string;
  kind: AttributeKind;
  required: boolean;
  list: boolean;
  options: AttributeOptions | null;
  extractable: boolean;
  /** Prompt copy. For a user attribute: its extraction hint, else its label. */
  description: string;
  sensitivity: Sensitivity;
  source: 'builtin' | 'mixin' | 'user';
  /** The declaring domain; null for a user attribute. */
  domain: DomainKey | null;
  attributeDefId: string | null;
  deprecated: boolean;
  sortOrder: number;
}

export interface EffectiveDomainPayload {
  key: DomainKey;
  label: string;
  enabled: boolean;
  alwaysOn: boolean;
}

export interface EffectiveEntityTypePayload {
  key: string;
  domain: DomainKey;
  label: string;
  pluralLabel: string;
  description: string;
  disambiguation: string[];
  storage: 'entity' | 'item';
  itemKind: KgItemKind | null;
  statuses: string[] | null;
  subjectTypes: string[] | null;
  subjectRequired: boolean;
  sensitivityDefault: Sensitivity;
  alignment: string | null;
  extractable: boolean;
  deprecated: boolean;
  attributes: EffectiveAttributePayload[];
}

export interface EffectiveRelationTypePayload {
  key: string;
  domain: DomainKey;
  label: string;
  description: string;
  from: string[];
  to: string[];
  allowedPairs: [string, string][] | null;
  temporal: boolean;
  exclusive: 'soft' | 'none';
  exclusiveScope: 'from' | 'from_to';
  representation: RelationRepresentation;
  extractable: boolean;
  alignment: string | null;
  deprecated: boolean;
  props: EffectiveAttributePayload[];
}

export interface EffectiveSchemaPayload {
  version: string;
  domains: EffectiveDomainPayload[];
  entityTypes: EffectiveEntityTypePayload[];
  relationTypes: EffectiveRelationTypePayload[];
}

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type EffectiveAttribute = DeepReadonly<EffectiveAttributePayload>;
export type EffectiveEntityType = DeepReadonly<EffectiveEntityTypePayload>;
export type EffectiveRelationType = DeepReadonly<EffectiveRelationTypePayload>;

/**
 * A resolved, deep-frozen view of one user's ontology. Build it with
 * `computeEffectiveSchema`; serialise it with `toEffectiveSchemaPayload`.
 */
export interface EffectiveSchema {
  readonly version: string;
  /** Registered domains in effect, in registry order; always includes `core`. */
  readonly enabledDomains: readonly DomainKey[];
  readonly domains: readonly DeepReadonly<EffectiveDomainPayload>[];
  readonly entityTypes: readonly EffectiveEntityType[];
  readonly relationTypes: readonly EffectiveRelationType[];
  entityType(key: string): EffectiveEntityType | undefined;
  relationType(key: string): EffectiveRelationType | undefined;
}

export interface ComputeEffectiveSchemaInput {
  /** The registry to resolve against. Defaults to `ONTOLOGY`. */
  registry?: OntologyRegistry;
  /** `core` (and any always-on domain) is forced in even if absent. */
  enabledDomains: readonly DomainKey[];
  userAttributes: readonly UserAttributeDef[];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function copyOptions(options: AttributeOptions | null | undefined): AttributeOptions | null {
  if (options === null || options === undefined) return null;
  const out: AttributeOptions = {};
  if (options.choices !== undefined) out.choices = options.choices.map((c) => ({ value: c.value, label: c.label }));
  if (options.targetTypes !== undefined) out.targetTypes = [...options.targetTypes];
  return out;
}

function builtinAttributes(
  attributes: Record<string, AttributeSpec>,
  source: 'builtin' | 'mixin',
  domain: DomainKey,
  sensitivityDefault: Sensitivity,
  startAt: number,
): EffectiveAttributePayload[] {
  return Object.entries(attributes).map(([key, spec], i) => ({
    key,
    label: spec.label,
    kind: spec.kind,
    required: spec.required ?? false,
    list: spec.list ?? false,
    options: copyOptions(spec.options),
    extractable: spec.extractable ?? false,
    description: spec.description,
    sensitivity: spec.sensitivity ?? sensitivityDefault,
    source,
    domain,
    attributeDefId: null,
    deprecated: spec.deprecated !== undefined,
    sortOrder: startAt + i,
  }));
}

function userAttribute(def: UserAttributeDef, sensitivityDefault: Sensitivity): EffectiveAttributePayload {
  const hint = typeof def.extractionHint === 'string' ? def.extractionHint.trim() : '';
  return {
    key: def.key,
    label: def.label,
    kind: def.kind,
    required: false,
    list: false,
    options: copyOptions(def.options),
    extractable: def.extractable,
    description: hint.length > 0 ? hint : def.label,
    sensitivity: def.sensitivity ?? sensitivityDefault,
    source: 'user',
    domain: null,
    attributeDefId: def.id,
    deprecated: def.deprecatedAt !== null && def.deprecatedAt !== undefined,
    sortOrder: def.sortOrder,
  };
}

function checkUserAttribute(def: UserAttributeDef): void {
  const where = `user attribute ${String(def?.id)}`;
  const fail = (rule: string): never => {
    throw new OntologyDefinitionError(`${where}: ${rule}`);
  };
  if (typeof def.id !== 'string' || def.id.length === 0) fail('id must be a non-empty string');
  if (typeof def.key !== 'string' || !USER_ATTRIBUTE_KEY_PATTERN.test(def.key)) {
    fail(`key '${String(def.key)}' must match ${USER_ATTRIBUTE_KEY_PATTERN}`);
  }
  if (typeof def.label !== 'string' || def.label.trim().length === 0) fail('label must be a non-empty string');
  if (!(ATTRIBUTE_KINDS as readonly string[]).includes(def.kind)) fail(`unknown kind '${String(def.kind)}'`);
  if (def.sensitivity !== null && !(SENSITIVITIES as readonly string[]).includes(def.sensitivity)) {
    fail(`unknown sensitivity '${String(def.sensitivity)}'`);
  }
  if (typeof def.sortOrder !== 'number' || !Number.isFinite(def.sortOrder)) fail('sortOrder must be a finite number');
  checkAttributeOptions(where, def.kind, def.options);
}

/**
 * Resolve one user's effective schema. Throws `OntologyDefinitionError` on a
 * malformed user attribute def (bad key, kind, options, or a duplicate key on
 * one type). A def whose entity type is not present — its domain is disabled,
 * or the type is unknown — is left out, not an error: disabling a domain must
 * never break the endpoint.
 */
export function computeEffectiveSchemaFor(registry: OntologyRegistry, input: ComputeEffectiveSchemaInput): EffectiveSchema {
  const requested = new Set<string>(input.enabledDomains);
  const domainsInEffect = registry
    .domains()
    .filter((d) => d.alwaysOn || d.key === 'core' || requested.has(d.key));
  const enabled = new Set<DomainKey>(domainsInEffect.map((d) => d.key));

  const presentTypes = new Set(
    registry
      .entityTypes()
      .filter((t) => enabled.has(t.domain))
      .map((t) => t.key),
  );
  const endpointPresent = (key: string) => presentTypes.has(key) || (PSEUDO_TYPES as readonly string[]).includes(key);

  const userByType = new Map<string, UserAttributeDef[]>();
  for (const def of input.userAttributes) {
    checkUserAttribute(def);
    if (!presentTypes.has(def.entityType)) continue;
    const list = userByType.get(def.entityType) ?? [];
    if (list.some((d) => d.key === def.key)) {
      throw new OntologyDefinitionError(`user attribute ${def.id}: key '${def.key}' is declared twice on ${def.entityType}`);
    }
    list.push(def);
    userByType.set(def.entityType, list);
  }

  const entityTypes: EffectiveEntityTypePayload[] = registry
    .entityTypes()
    .filter((t) => presentTypes.has(t.key))
    .map((t) => {
      const attributes = builtinAttributes(t.attributes, 'builtin', t.domain, t.sensitivityDefault, 0);
      for (const d of domainsInEffect) {
        for (const mixin of d.mixins) {
          if (mixin.entityType !== t.key) continue;
          attributes.push(...builtinAttributes(mixin.attributes, 'mixin', d.key, t.sensitivityDefault, attributes.length));
        }
      }
      const users = [...(userByType.get(t.key) ?? [])].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key) || a.id.localeCompare(b.id),
      );
      attributes.push(...users.map((def) => userAttribute(def, t.sensitivityDefault)));
      const isItem = t.itemKind !== undefined;
      return {
        key: t.key,
        domain: t.domain,
        label: t.label,
        pluralLabel: t.pluralLabel,
        description: t.description,
        disambiguation: [...t.disambiguation],
        storage: isItem ? 'item' : 'entity',
        itemKind: t.itemKind ?? null,
        statuses: t.statuses ? [...t.statuses] : null,
        subjectTypes: isItem ? (t.subjectTypes ?? []).filter((s) => presentTypes.has(s)) : null,
        subjectRequired: t.subjectRequired ?? false,
        sensitivityDefault: t.sensitivityDefault,
        alignment: t.alignment ?? null,
        extractable: t.extractable !== false,
        deprecated: t.deprecated !== undefined,
        attributes,
      };
    });

  const relationTypes: EffectiveRelationTypePayload[] = [];
  for (const r of registry.relationTypes()) {
    if (!enabled.has(r.domain)) continue;
    let from = r.from.filter(endpointPresent);
    let to = r.to.filter(endpointPresent);
    let allowedPairs: [string, string][] | null = null;
    if (r.allowedPairs !== undefined) {
      allowedPairs = r.allowedPairs
        .filter(([a, b]) => from.includes(a) && to.includes(b))
        .map(([a, b]) => [a, b] as [string, string]);
      // Narrow the endpoint lists to what some surviving pair still uses.
      from = from.filter((f) => allowedPairs!.some(([a]) => a === f));
      to = to.filter((t) => allowedPairs!.some(([, b]) => b === t));
      if (allowedPairs.length === 0) continue;
    }
    if (from.length === 0 || to.length === 0) continue;
    relationTypes.push({
      key: r.key,
      domain: r.domain,
      label: r.label,
      description: r.description,
      from,
      to,
      allowedPairs,
      temporal: r.temporal,
      exclusive: r.exclusive,
      exclusiveScope: r.exclusiveScope ?? 'from',
      representation: JSON.parse(JSON.stringify(r.representation)) as RelationRepresentation,
      extractable: r.extractable,
      alignment: r.alignment ?? null,
      deprecated: r.deprecated !== undefined,
      props: builtinAttributes(r.props, 'builtin', r.domain, 'business', 0),
    });
  }

  const domains: EffectiveDomainPayload[] = registry.domains().map((d) => ({
    key: d.key,
    label: d.label,
    enabled: enabled.has(d.key),
    alwaysOn: d.alwaysOn,
  }));

  deepFreeze(entityTypes);
  deepFreeze(relationTypes);
  deepFreeze(domains);
  const entityByKey = new Map<string, EffectiveEntityType>(entityTypes.map((t) => [t.key, t]));
  const relationByKey = new Map<string, EffectiveRelationType>(relationTypes.map((r) => [r.key, r]));

  const schema: EffectiveSchema = {
    version: registry.version,
    enabledDomains: Object.freeze(domainsInEffect.map((d) => d.key)),
    domains,
    entityTypes,
    relationTypes,
    entityType: (key: string) => entityByKey.get(key),
    relationType: (key: string) => relationByKey.get(key),
  };
  return Object.freeze(schema);
}

/**
 * The JSON-safe payload `GET /api/graph/ontology` returns: a fresh, mutable,
 * plain-data copy (`JSON.parse(JSON.stringify(p))` deep-equals it).
 */
export function toEffectiveSchemaPayload(schema: EffectiveSchema): EffectiveSchemaPayload {
  return JSON.parse(
    JSON.stringify({
      version: schema.version,
      domains: schema.domains,
      entityTypes: schema.entityTypes,
      relationTypes: schema.relationTypes,
    }),
  ) as EffectiveSchemaPayload;
}

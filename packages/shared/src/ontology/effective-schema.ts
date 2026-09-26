// =============================================================================
// The effective schema (docs/specs/ontology.md §17.2, §17.3, §17.4)
// =============================================================================
//
// One caller's resolved ontology, computed -- never hand-assembled -- as
// `core ∪ {enabled domains}`, with:
//
//   - every domain's mixins merged onto their target type (only when that
//     domain is enabled);
//   - the caller's own user attribute definitions merged after the built-ins,
//     ordered by `sortOrder`;
//   - relation endpoint lists, item subject types and `entity_ref` targets
//     narrowed to the types actually present. A relation whose `from` or `to`
//     empties (e.g. `WORKS_FOR` with `work` off) is omitted entirely.
//
// `toEffectiveSchemaPayload()` is the JSON-safe form `GET /api/graph/ontology`
// (#354) returns and every web form renders from.
// =============================================================================

import {
  ATTRIBUTE_KINDS,
  DOMAIN_KEYS,
  PSEUDO_TYPES,
  SENSITIVITIES,
  USER_ATTRIBUTE_KEY_PATTERN,
} from './constants.js';
import { OntologyDefinitionError, deepFreeze } from './define.js';
import { ONTOLOGY } from './registry.js';
import type {
  AttributeOptions,
  AttributeSpec,
  DomainKey,
  EffectiveAttribute,
  EffectiveAttributePayload,
  EffectiveEntityType,
  EffectiveRelationType,
  EffectiveSchema,
  EffectiveSchemaPayload,
  OntologyRegistry,
  Sensitivity,
  UserAttributeDef,
} from './types.js';

export interface ComputeEffectiveSchemaInput {
  /** Default: `ONTOLOGY`. */
  registry?: OntologyRegistry;
  /** Domains the caller has enabled. Always-on domains (`core`) are forced in. */
  enabledDomains: readonly DomainKey[];
  /** The caller's own `kg_attribute_defs` rows, as plain data. */
  userAttributes: readonly UserAttributeDef[];
}

function cloneOptions(options: AttributeOptions | null | undefined, present: ReadonlySet<string>): AttributeOptions | null {
  if (!options) return null;
  const out: AttributeOptions = {};
  if (options.choices !== undefined) out.choices = options.choices.map((c) => ({ value: c.value, label: c.label }));
  if (options.targetTypes !== undefined) out.targetTypes = options.targetTypes.filter((t) => present.has(t));
  return Object.keys(out).length > 0 ? out : null;
}

function builtinAttribute(
  key: string,
  spec: AttributeSpec,
  source: 'builtin' | 'mixin',
  domain: DomainKey,
  sortOrder: number,
  typeSensitivity: Sensitivity,
  present: ReadonlySet<string>,
): EffectiveAttributePayload {
  return {
    key,
    label: spec.label,
    kind: spec.kind,
    required: spec.required === true,
    list: spec.list === true,
    options: cloneOptions(spec.options, present),
    extractable: spec.extractable === true,
    description: spec.description,
    sensitivity: spec.sensitivity ?? typeSensitivity,
    source,
    domain,
    attributeDefId: null,
    deprecated: spec.deprecated !== undefined,
    sortOrder,
  };
}

function assertUserDef(def: UserAttributeDef): void {
  const name = `User attribute ${def.id} (${def.entityType}.${def.key})`;
  if (!USER_ATTRIBUTE_KEY_PATTERN.test(def.key)) {
    throw new OntologyDefinitionError(`${name}: key must match ${String(USER_ATTRIBUTE_KEY_PATTERN)}`);
  }
  if (!(ATTRIBUTE_KINDS as readonly string[]).includes(def.kind)) {
    throw new OntologyDefinitionError(`${name}: unknown kind '${String(def.kind)}'`);
  }
  if (def.sensitivity !== null && !(SENSITIVITIES as readonly string[]).includes(def.sensitivity)) {
    throw new OntologyDefinitionError(`${name}: unknown sensitivity '${String(def.sensitivity)}'`);
  }
}

function userAttribute(def: UserAttributeDef, typeSensitivity: Sensitivity, present: ReadonlySet<string>): EffectiveAttributePayload {
  const hint = def.extractionHint?.trim();
  return {
    key: def.key,
    label: def.label,
    kind: def.kind,
    required: false,
    list: false,
    options: cloneOptions(def.options, present),
    extractable: def.extractable,
    description: hint ? hint : def.label,
    sensitivity: def.sensitivity ?? typeSensitivity,
    source: 'user',
    domain: null,
    attributeDefId: def.id,
    deprecated: def.deprecatedAt !== null,
    sortOrder: def.sortOrder,
  };
}

/**
 * Resolves one caller's effective schema. Throws `OntologyDefinitionError`
 * for a malformed user attribute definition (a bad key or kind, or a key used
 * twice on one type). A definition for a type the caller does not currently
 * have (its domain is off) is legitimately skipped, not an error.
 */
export function computeEffectiveSchema(input: ComputeEffectiveSchemaInput): EffectiveSchema {
  const registry = input.registry ?? ONTOLOGY;
  const requested = new Set<string>(input.enabledDomains);
  const modules = registry.domains();
  const enabled = new Set<DomainKey>();
  for (const mod of modules) {
    if (mod.alwaysOn || requested.has(mod.key)) enabled.add(mod.key);
  }

  const presentEntities = registry.entityTypes().filter((t) => enabled.has(t.domain));
  const presentKeys = new Set(presentEntities.map((t) => t.key));
  const presentOrPseudo = new Set<string>([...presentKeys, ...PSEUDO_TYPES]);

  // Mixins from enabled domains, grouped by target type, in module order.
  const mixinsByType = new Map<string, { domain: DomainKey; key: string; spec: AttributeSpec }[]>();
  for (const mod of modules) {
    if (!enabled.has(mod.key)) continue;
    for (const mixin of mod.mixins) {
      const list = mixinsByType.get(mixin.entityType) ?? [];
      for (const [key, spec] of Object.entries(mixin.attributes)) list.push({ domain: mod.key, key, spec });
      mixinsByType.set(mixin.entityType, list);
    }
  }

  // User attribute defs, grouped by type, sorted by (sortOrder, key).
  const userByType = new Map<string, UserAttributeDef[]>();
  for (const def of input.userAttributes) {
    assertUserDef(def);
    if (!presentKeys.has(def.entityType)) continue;
    const list = userByType.get(def.entityType) ?? [];
    list.push(def);
    userByType.set(def.entityType, list);
  }

  const entityTypes: EffectiveEntityType[] = presentEntities.map((type) => {
    const attributes: EffectiveAttributePayload[] = [];
    let order = 0;
    for (const [key, spec] of Object.entries(type.attributes)) {
      attributes.push(builtinAttribute(key, spec, 'builtin', type.domain, order++, type.sensitivityDefault, presentKeys));
    }
    for (const m of mixinsByType.get(type.key) ?? []) {
      attributes.push(builtinAttribute(m.key, m.spec, 'mixin', m.domain, order++, type.sensitivityDefault, presentKeys));
    }
    const seen = new Set(attributes.map((a) => a.key));
    const userDefs = [...(userByType.get(type.key) ?? [])].sort(
      (a, b) => a.sortOrder - b.sortOrder || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    for (const def of userDefs) {
      if (seen.has(def.key)) {
        throw new OntologyDefinitionError(`User attribute ${def.id}: key '${def.key}' is used twice on ${type.key}`);
      }
      seen.add(def.key);
      attributes.push(userAttribute(def, type.sensitivityDefault, presentKeys));
    }

    const isItem = type.itemKind !== undefined;
    return {
      key: type.key,
      domain: type.domain,
      label: type.label,
      pluralLabel: type.pluralLabel,
      description: type.description,
      disambiguation: [...type.disambiguation],
      storage: isItem ? 'item' : 'entity',
      itemKind: type.itemKind ?? null,
      statuses: type.statuses ? [...type.statuses] : null,
      subjectTypes: type.subjectTypes ? type.subjectTypes.filter((t) => presentKeys.has(t)) : null,
      subjectRequired: type.subjectRequired === true,
      sensitivityDefault: type.sensitivityDefault,
      alignment: type.alignment ?? null,
      extractable: type.extractable !== false,
      deprecated: type.deprecated !== undefined,
      attributes,
    };
  });

  const relationTypes: EffectiveRelationType[] = [];
  for (const rel of registry.relationTypes()) {
    if (!enabled.has(rel.domain)) continue;
    const from = rel.from.filter((t) => presentOrPseudo.has(t));
    const to = rel.to.filter((t) => presentOrPseudo.has(t));
    if (from.length === 0 || to.length === 0) continue;
    let allowedPairs: [string, string][] | null = null;
    if (rel.allowedPairs) {
      allowedPairs = rel.allowedPairs
        .filter(([f, t]) => presentOrPseudo.has(f) && presentOrPseudo.has(t))
        .map(([f, t]) => [f, t] as [string, string]);
      if (allowedPairs.length === 0) continue;
    }
    let order = 0;
    const props = Object.entries(rel.props).map(([key, spec]) =>
      // A relation prop has no owning-type sensitivity; business is the floor.
      builtinAttribute(key, spec, 'builtin', rel.domain, order++, 'business', presentKeys),
    );
    relationTypes.push({
      key: rel.key,
      domain: rel.domain,
      label: rel.label,
      description: rel.description,
      from,
      to,
      allowedPairs,
      temporal: rel.temporal,
      exclusive: rel.exclusive,
      exclusiveScope: rel.exclusiveScope ?? 'from',
      representation: { ...rel.representation },
      extractable: rel.extractable,
      alignment: rel.alignment ?? null,
      deprecated: rel.deprecated !== undefined,
      props,
    });
  }

  const domains = modules.map((mod) => ({
    key: mod.key,
    label: mod.label,
    enabled: enabled.has(mod.key),
    alwaysOn: mod.alwaysOn,
  }));

  const entityTypeByKey = new Map(entityTypes.map((t) => [t.key, t] as const));
  const relationTypeByKey = new Map(relationTypes.map((r) => [r.key, r] as const));
  deepFreeze(entityTypes);
  deepFreeze(relationTypes);
  deepFreeze(domains);

  return Object.freeze({
    version: registry.version,
    domains,
    enabledDomains: Object.freeze(DOMAIN_KEYS.filter((k) => enabled.has(k))),
    entityTypes,
    relationTypes,
    entityTypeByKey,
    relationTypeByKey,
  });
}

function attributePayload(a: EffectiveAttribute): EffectiveAttributePayload {
  return {
    key: a.key,
    label: a.label,
    kind: a.kind,
    required: a.required,
    list: a.list,
    options: a.options
      ? {
          ...(a.options.choices !== undefined ? { choices: a.options.choices.map((c) => ({ ...c })) } : {}),
          ...(a.options.targetTypes !== undefined ? { targetTypes: [...a.options.targetTypes] } : {}),
        }
      : null,
    extractable: a.extractable,
    description: a.description,
    sensitivity: a.sensitivity,
    source: a.source,
    domain: a.domain,
    attributeDefId: a.attributeDefId,
    deprecated: a.deprecated,
    sortOrder: a.sortOrder,
  };
}

/** The JSON-safe wire form: plain, unfrozen, no maps, no `undefined`. */
export function toEffectiveSchemaPayload(schema: EffectiveSchema): EffectiveSchemaPayload {
  return {
    version: schema.version,
    domains: schema.domains.map((d) => ({ ...d })),
    entityTypes: schema.entityTypes.map((t) => ({
      key: t.key,
      domain: t.domain,
      label: t.label,
      pluralLabel: t.pluralLabel,
      description: t.description,
      disambiguation: [...t.disambiguation],
      storage: t.storage,
      itemKind: t.itemKind,
      statuses: t.statuses ? [...t.statuses] : null,
      subjectTypes: t.subjectTypes ? [...t.subjectTypes] : null,
      subjectRequired: t.subjectRequired,
      sensitivityDefault: t.sensitivityDefault,
      alignment: t.alignment,
      extractable: t.extractable,
      deprecated: t.deprecated,
      attributes: t.attributes.map(attributePayload),
    })),
    relationTypes: schema.relationTypes.map((r) => ({
      key: r.key,
      domain: r.domain,
      label: r.label,
      description: r.description,
      from: [...r.from],
      to: [...r.to],
      allowedPairs: r.allowedPairs ? r.allowedPairs.map(([f, t]) => [f, t] as [string, string]) : null,
      temporal: r.temporal,
      exclusive: r.exclusive,
      exclusiveScope: r.exclusiveScope,
      representation: { ...r.representation },
      extractable: r.extractable,
      alignment: r.alignment,
      deprecated: r.deprecated,
      props: r.props.map(attributePayload),
    })),
  };
}

/** Looks up an entity type, or a relation type when `relation` is true. */
export function lookupEffectiveType(
  schema: EffectiveSchema,
  typeKey: string,
  relation: boolean,
): EffectiveEntityType | EffectiveRelationType | undefined {
  return relation ? schema.relationTypeByKey.get(typeKey) : schema.entityTypeByKey.get(typeKey);
}

/** The attributes (entity) or props (relation) of a resolved type. */
export function effectiveAttributesOf(type: EffectiveEntityType | EffectiveRelationType): readonly EffectiveAttribute[] {
  return 'attributes' in type ? type.attributes : type.props;
}

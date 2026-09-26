// =============================================================================
// The ontology registry (docs/specs/ontology.md §17.2).
//
// Domain modules are passed in as an EXPLICIT list (see `index.ts`), never
// registered by import side effect: under Vite's CJS pre-bundling and Jest's
// `require`, side-effect order is a property of the bundler, and a registry
// whose contents depend on import order is one that differs between the web
// app and the API. One line per domain keeps adding a domain a one-line change.
//
// `buildOntologyRegistry` runs every cross-module check `define.ts` cannot,
// because it needs all modules at once: duplicate keys, unknown domains,
// dangling endpoints, mixin targets and collisions.
// =============================================================================

import { DOMAIN_KEYS, ITEM_KINDS, PSEUDO_TYPES } from './constants.js';
import { defineDomain, OntologyDefinitionError } from './define.js';
import type { DomainModule, EntityTypeSpec, RelationTypeSpec } from './types.js';

export interface OntologyRegistry {
  version: string;
  domains(): readonly DomainModule[];
  entityType(key: string): Readonly<EntityTypeSpec> | undefined;
  relationType(key: string): Readonly<RelationTypeSpec> | undefined;
  entityTypes(): readonly Readonly<EntityTypeSpec>[];
  relationTypes(): readonly Readonly<RelationTypeSpec>[];
}

/** Semver `MAJOR.MINOR.PATCH`, no pre-release or build suffix. */
export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Representations whose endpoints may name a pseudo-type (Speaker, Note, Transcript). */
const PSEUDO_REPRESENTATIONS = ['speaker_link', 'mention', 'evidence'];

function fail(where: string, rule: string): never {
  throw new OntologyDefinitionError(`${where}: ${rule}`);
}

export function buildOntologyRegistry(mods: DomainModule[], version: string): OntologyRegistry {
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    fail('ontology', `version '${String(version)}' is not semver MAJOR.MINOR.PATCH`);
  }
  const domains = mods.map((m) => defineDomain(m));

  const domainKeys = new Set<string>();
  for (const d of domains) {
    if (!(DOMAIN_KEYS as readonly string[]).includes(d.key)) fail(`domain ${d.key}`, 'unknown domain key');
    if (domainKeys.has(d.key)) fail(`domain ${d.key}`, 'declared twice');
    domainKeys.add(d.key);
  }
  if (!domainKeys.has('core')) fail('ontology', "the 'core' domain is required");
  for (const d of domains) {
    if (d.alwaysOn && d.key !== 'core') fail(`domain ${d.key}`, "only 'core' may be always on");
  }

  const entities = new Map<string, Readonly<EntityTypeSpec>>();
  const relations = new Map<string, Readonly<RelationTypeSpec>>();
  for (const d of domains) {
    for (const t of d.entityTypes) {
      if (entities.has(t.key)) fail(`entity type ${t.key}`, 'declared twice');
      if ((PSEUDO_TYPES as readonly string[]).includes(t.key)) fail(`entity type ${t.key}`, 'collides with a pseudo-type');
      entities.set(t.key, t);
    }
    for (const r of d.relationTypes) {
      if (relations.has(r.key)) fail(`relation type ${r.key}`, 'declared twice');
      relations.set(r.key, r);
    }
  }

  const isEntityStorage = (key: string) => {
    const t = entities.get(key);
    return t !== undefined && t.itemKind === undefined;
  };

  // Item types: each ITEM_KIND at most once; subject types resolve to entity-storage types.
  const itemKinds = new Set<string>();
  for (const t of entities.values()) {
    if (t.itemKind === undefined) continue;
    if (itemKinds.has(t.itemKind)) fail(`entity type ${t.key}`, `itemKind '${t.itemKind}' is already used`);
    itemKinds.add(t.itemKind);
    for (const s of t.subjectTypes ?? []) {
      if (!isEntityStorage(s)) fail(`entity type ${t.key}`, `subject type '${s}' is not a registered entity-storage type`);
    }
  }
  for (const k of itemKinds) {
    if (!(ITEM_KINDS as readonly string[]).includes(k)) fail('ontology', `unknown itemKind '${k}'`);
  }

  // Relations: every endpoint is a registered type or a pseudo-type, and
  // pseudo-types only appear in speaker_link / mention / evidence relations.
  for (const r of relations.values()) {
    for (const side of ['from', 'to'] as const) {
      for (const endpoint of r[side]) {
        const pseudo = (PSEUDO_TYPES as readonly string[]).includes(endpoint);
        if (!pseudo && !entities.has(endpoint)) {
          fail(`relation type ${r.key}`, `${side} endpoint '${endpoint}' is not a registered type`);
        }
        if (pseudo && !PSEUDO_REPRESENTATIONS.includes(r.representation.kind)) {
          fail(`relation type ${r.key}`, `pseudo-type '${endpoint}' is only valid in speaker_link/mention/evidence relations`);
        }
      }
    }
    if (r.representation.kind === 'item_column') {
      for (const f of r.from) {
        if (entities.get(f)?.itemKind === undefined) {
          fail(`relation type ${r.key}`, `an item_column relation may only start at an item type, not '${f}'`);
        }
      }
    }
  }

  // entity_ref target types resolve.
  const checkTargets = (where: string, attrs: Record<string, { options?: { targetTypes?: string[] } }>) => {
    for (const [key, spec] of Object.entries(attrs)) {
      for (const target of spec.options?.targetTypes ?? []) {
        if (!entities.has(target)) fail(`${where}.${key}`, `entity_ref target '${target}' is not a registered type`);
      }
    }
  };
  for (const t of entities.values()) checkTargets(t.key, t.attributes);
  for (const r of relations.values()) checkTargets(r.key, r.props);

  // Mixins: the target exists, and no key collides with a base attribute or
  // another domain's mixin on the same type.
  const mixinKeys = new Map<string, string>(); // `Type.attr` -> domain
  for (const d of domains) {
    for (const mixin of d.mixins) {
      const target = entities.get(mixin.entityType);
      const where = `domain ${d.key} mixin on ${mixin.entityType}`;
      if (target === undefined) fail(where, 'target is not a registered entity type');
      if (target.domain === d.key) fail(where, "a domain declares its own type's attributes directly, not as a mixin");
      checkTargets(`${mixin.entityType}`, mixin.attributes);
      for (const key of Object.keys(mixin.attributes)) {
        if (key in target.attributes) fail(`${where}.${key}`, 'collides with a base attribute of the same key');
        const other = mixinKeys.get(`${mixin.entityType}.${key}`);
        if (other !== undefined) fail(`${where}.${key}`, `collides with domain ${other}'s mixin of the same key`);
        mixinKeys.set(`${mixin.entityType}.${key}`, d.key);
      }
    }
  }

  const frozenDomains = Object.freeze([...domains]) as readonly DomainModule[];
  const entityList = Object.freeze([...entities.values()]);
  const relationList = Object.freeze([...relations.values()]);

  return Object.freeze({
    version,
    domains: () => frozenDomains,
    entityType: (key: string) => entities.get(key),
    relationType: (key: string) => relations.get(key),
    entityTypes: () => entityList,
    relationTypes: () => relationList,
  });
}

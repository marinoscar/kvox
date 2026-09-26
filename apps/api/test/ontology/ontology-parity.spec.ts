import {
  ATTRIBUTE_KINDS,
  ITEM_KINDS,
  ONTOLOGY,
  ONTOLOGY_VERSION,
  PSEUDO_TYPES,
  SHIPPED_KEYS,
  CHANGELOG,
  computeEffectiveSchema,
  DEFAULT_ENABLED_DOMAINS,
} from '@app/shared/ontology';
import type { EntityTypeSpec, RelationTypeSpec } from '@app/shared/ontology';

// =============================================================================
// Ontology parity guard (issue #350, epic #344).
// =============================================================================
//
// WHAT A FAILURE HERE MEANS. A rule the ontology definition (docs/specs/
// ontology.md §17) requires of every type, relation or attribute is broken by
// one of them. Every failure message below names the offending key AND the
// rule it breaks, following the pattern established by
// `apps/api/src/common/schemas/settings-parity.spec.ts`: a reader who has just
// broken a rule should be able to find the fix from the assertion message
// alone, without re-deriving which rule failed.
//
// The ten rules are numbered exactly as `docs/specs/ontology.md` / issue #350
// numbers them; one `it` per rule.
// =============================================================================

const MIN_DESCRIPTION_LENGTH = 20;

const entityTypes = ONTOLOGY.entityTypes();
const relationTypes = ONTOLOGY.relationTypes();

const ENTITY_TYPE_KEY_PATTERN = /^[A-Z][A-Za-z]+$/;
const RELATION_TYPE_KEY_PATTERN = /^[A-Z][A-Z_]+$/;
const ATTRIBUTE_KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;

const PSEUDO_REPRESENTATIONS = ['speaker_link', 'mention', 'evidence'];

function attributeEntries(type: Readonly<EntityTypeSpec> | Readonly<RelationTypeSpec>, field: 'attributes' | 'props') {
  return Object.entries((type as unknown as Record<string, Record<string, { kind: unknown }>>)[field] ?? {});
}

describe('ontology parity across the rules docs/specs/ontology.md §17 requires', () => {
  it('rule 1: every entity and relation type has a label and a description of at least 20 characters; every entity type has at least one disambiguation rule', () => {
    const failures: string[] = [];

    for (const t of entityTypes) {
      if (typeof t.label !== 'string' || t.label.trim().length === 0) {
        failures.push(`rule 1: entity type '${t.key}' has no label`);
      }
      if (typeof t.description !== 'string' || t.description.length < MIN_DESCRIPTION_LENGTH) {
        failures.push(`rule 1: entity type '${t.key}' description is shorter than ${MIN_DESCRIPTION_LENGTH} characters`);
      }
      if (!Array.isArray(t.disambiguation) || t.disambiguation.length === 0) {
        failures.push(`rule 1: entity type '${t.key}' has no disambiguation rule`);
      }
    }

    for (const r of relationTypes) {
      if (typeof r.label !== 'string' || r.label.trim().length === 0) {
        failures.push(`rule 1: relation type '${r.key}' has no label`);
      }
      if (typeof r.description !== 'string' || r.description.length < MIN_DESCRIPTION_LENGTH) {
        failures.push(`rule 1: relation type '${r.key}' description is shorter than ${MIN_DESCRIPTION_LENGTH} characters`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('rule 2: every relation has non-empty from/to, every endpoint is a registered type or a pseudo-type, pseudo-types appear only in speaker_link/mention/evidence relations, and allowedPairs is a subset of from x to', () => {
    const failures: string[] = [];
    const entityKeys = new Set(entityTypes.map((t) => t.key));

    for (const r of relationTypes) {
      for (const side of ['from', 'to'] as const) {
        const list = r[side];
        if (!Array.isArray(list) || list.length === 0) {
          failures.push(`rule 2: relation '${r.key}'.${side} is empty`);
          continue;
        }
        for (const endpoint of list) {
          const isPseudo = (PSEUDO_TYPES as readonly string[]).includes(endpoint);
          const isRegistered = entityKeys.has(endpoint);
          if (!isPseudo && !isRegistered) {
            failures.push(`rule 2: relation '${r.key}'.${side} endpoint '${endpoint}' is neither a registered type nor a pseudo-type`);
          }
          if (isPseudo && !PSEUDO_REPRESENTATIONS.includes(r.representation.kind)) {
            failures.push(
              `rule 2: relation '${r.key}' names pseudo-type '${endpoint}' but its representation.kind ('${r.representation.kind}') is not speaker_link/mention/evidence`,
            );
          }
        }
      }
      if (r.allowedPairs !== undefined) {
        for (const [a, b] of r.allowedPairs) {
          if (!r.from.includes(a) || !r.to.includes(b)) {
            failures.push(`rule 2: relation '${r.key}'.allowedPairs contains [${a}, ${b}], which is not within from x to`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('rule 3: every attribute has a kind in ATTRIBUTE_KINDS; select/multi_select have at least one choice with unique values; entity_ref targetTypes resolve to registered types', () => {
    const failures: string[] = [];
    const entityKeys = new Set(entityTypes.map((t) => t.key));

    const checkAttrs = (owner: string, attrs: Record<string, { kind: unknown; options?: { choices?: { value: string }[]; targetTypes?: string[] } }>) => {
      for (const [key, spec] of Object.entries(attrs)) {
        const where = `${owner}.${key}`;
        if (!(ATTRIBUTE_KINDS as readonly string[]).includes(spec.kind as string)) {
          failures.push(`rule 3: attribute '${where}' has kind '${String(spec.kind)}', not in ATTRIBUTE_KINDS`);
          continue;
        }
        if (spec.kind === 'select' || spec.kind === 'multi_select') {
          const choices = spec.options?.choices ?? [];
          if (choices.length === 0) {
            failures.push(`rule 3: attribute '${where}' is a ${spec.kind} with no choices`);
          }
          const values = choices.map((c) => c.value);
          if (new Set(values).size !== values.length) {
            failures.push(`rule 3: attribute '${where}' has duplicate choice values`);
          }
        }
        if (spec.kind === 'entity_ref') {
          for (const target of spec.options?.targetTypes ?? []) {
            if (!entityKeys.has(target)) {
              failures.push(`rule 3: attribute '${where}' entity_ref targetTypes names unregistered type '${target}'`);
            }
          }
        }
      }
    };

    for (const t of entityTypes) checkAttrs(t.key, t.attributes);
    for (const r of relationTypes) checkAttrs(r.key, r.props);
    for (const d of ONTOLOGY.domains()) {
      for (const mixin of d.mixins) checkAttrs(mixin.entityType, mixin.attributes);
    }

    expect(failures).toEqual([]);
  });

  it('rule 4: keys are never removed — every SHIPPED_KEYS entry still exists in the registry (deprecated allowed), and every registry key is recorded in SHIPPED_KEYS', () => {
    const failures: string[] = [];

    const registryKeys = new Set<string>();
    for (const t of entityTypes) {
      registryKeys.add(t.key);
      for (const key of Object.keys(t.attributes)) registryKeys.add(`${t.key}.${key}`);
    }
    for (const r of relationTypes) {
      registryKeys.add(r.key);
      for (const key of Object.keys(r.props)) registryKeys.add(`${r.key}.${key}`);
    }
    for (const d of ONTOLOGY.domains()) {
      for (const mixin of d.mixins) {
        for (const key of Object.keys(mixin.attributes)) registryKeys.add(`${mixin.entityType}.${key}`);
      }
    }

    for (const shipped of SHIPPED_KEYS) {
      if (!registryKeys.has(shipped)) {
        failures.push(`rule 4: SHIPPED_KEYS entry '${shipped}' no longer exists in the registry (keys are permanent — deprecate, never remove)`);
      }
    }
    for (const key of registryKeys) {
      if (!SHIPPED_KEYS.includes(key)) {
        failures.push(`rule 4: registry key '${key}' is missing from SHIPPED_KEYS (append it in the same change that declares it)`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('rule 5: key formats — entity/item types PascalCase, relations SCREAMING_SNAKE, attributes camelCase, none starting with u_', () => {
    const failures: string[] = [];

    for (const t of entityTypes) {
      if (!ENTITY_TYPE_KEY_PATTERN.test(t.key)) {
        failures.push(`rule 5: entity type key '${t.key}' does not match ${ENTITY_TYPE_KEY_PATTERN}`);
      }
      for (const key of Object.keys(t.attributes)) {
        if (!ATTRIBUTE_KEY_PATTERN.test(key) || key.startsWith('u_')) {
          failures.push(`rule 5: attribute key '${t.key}.${key}' does not match ${ATTRIBUTE_KEY_PATTERN}, or starts with 'u_'`);
        }
      }
    }
    for (const r of relationTypes) {
      if (!RELATION_TYPE_KEY_PATTERN.test(r.key)) {
        failures.push(`rule 5: relation type key '${r.key}' does not match ${RELATION_TYPE_KEY_PATTERN}`);
      }
      for (const key of Object.keys(r.props)) {
        if (!ATTRIBUTE_KEY_PATTERN.test(key) || key.startsWith('u_')) {
          failures.push(`rule 5: relation prop key '${r.key}.${key}' does not match ${ATTRIBUTE_KEY_PATTERN}, or starts with 'u_'`);
        }
      }
    }
    for (const d of ONTOLOGY.domains()) {
      for (const mixin of d.mixins) {
        for (const key of Object.keys(mixin.attributes)) {
          if (!ATTRIBUTE_KEY_PATTERN.test(key) || key.startsWith('u_')) {
            failures.push(`rule 5: mixin attribute key '${mixin.entityType}.${key}' does not match ${ATTRIBUTE_KEY_PATTERN}, or starts with 'u_'`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('rule 6: exclusive "soft" implies temporal, and temporal implies representation.kind === "edge"', () => {
    const failures: string[] = [];

    for (const r of relationTypes) {
      if (r.exclusive === 'soft' && !r.temporal) {
        failures.push(`rule 6: relation '${r.key}' is exclusive: 'soft' but not temporal`);
      }
      if (r.temporal && r.representation.kind !== 'edge') {
        failures.push(`rule 6: relation '${r.key}' is temporal but represented as '${r.representation.kind}', not 'edge'`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('rule 7: item types have an itemKind, non-empty statuses and subjectTypes; every ITEM_KINDS member is used exactly once', () => {
    const failures: string[] = [];
    const usage = new Map<string, number>();

    for (const t of entityTypes) {
      if (t.itemKind === undefined) continue;
      usage.set(t.itemKind, (usage.get(t.itemKind) ?? 0) + 1);
      if (!Array.isArray(t.statuses) || t.statuses.length === 0) {
        failures.push(`rule 7: item type '${t.key}' has no statuses`);
      }
      if (!Array.isArray(t.subjectTypes) || t.subjectTypes.length === 0) {
        failures.push(`rule 7: item type '${t.key}' has no subjectTypes`);
      }
    }

    for (const kind of ITEM_KINDS) {
      const count = usage.get(kind) ?? 0;
      if (count !== 1) {
        failures.push(`rule 7: itemKind '${kind}' is used ${count} times, expected exactly 1`);
      }
    }
    for (const kind of usage.keys()) {
      if (!(ITEM_KINDS as readonly string[]).includes(kind)) {
        failures.push(`rule 7: itemKind '${kind}' is not a member of ITEM_KINDS`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('rule 8: ONTOLOGY_VERSION is semver and equals the last CHANGELOG entry; versions strictly increase', () => {
    const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
    const failures: string[] = [];

    if (!SEMVER.test(ONTOLOGY_VERSION)) {
      failures.push(`rule 8: ONTOLOGY_VERSION '${ONTOLOGY_VERSION}' is not semver MAJOR.MINOR.PATCH`);
    }
    if (CHANGELOG.length === 0) {
      failures.push('rule 8: CHANGELOG is empty');
    } else {
      const last = CHANGELOG[CHANGELOG.length - 1];
      if (last.version !== ONTOLOGY_VERSION) {
        failures.push(`rule 8: last CHANGELOG entry version '${last.version}' does not equal ONTOLOGY_VERSION '${ONTOLOGY_VERSION}'`);
      }
    }

    const toParts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10));
    const compare = (a: number[], b: number[]) => {
      for (let i = 0; i < 3; i += 1) {
        if (a[i] !== b[i]) return a[i] - b[i];
      }
      return 0;
    };
    for (let i = 1; i < CHANGELOG.length; i += 1) {
      const prev = toParts(CHANGELOG[i - 1].version);
      const curr = toParts(CHANGELOG[i].version);
      if (compare(prev, curr) >= 0) {
        failures.push(`rule 8: CHANGELOG version '${CHANGELOG[i].version}' does not strictly increase over '${CHANGELOG[i - 1].version}'`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('rule 9: the core-only effective schema has no dangling endpoint', () => {
    const schema = computeEffectiveSchema({ enabledDomains: [], userAttributes: [] });
    const failures: string[] = [];
    const entityKeys = new Set(schema.entityTypes.map((t) => t.key));

    for (const r of schema.relationTypes) {
      for (const side of ['from', 'to'] as const) {
        for (const endpoint of r[side]) {
          const isPseudo = (PSEUDO_TYPES as readonly string[]).includes(endpoint);
          if (!isPseudo && !entityKeys.has(endpoint)) {
            failures.push(`rule 9: core-only relation '${r.key}'.${side} names dangling endpoint '${endpoint}'`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('rule 10: mixin keys never collide with a base attribute key on the type they mix onto', () => {
    const failures: string[] = [];

    for (const d of ONTOLOGY.domains()) {
      for (const mixin of d.mixins) {
        const target = ONTOLOGY.entityType(mixin.entityType);
        if (target === undefined) continue;
        for (const key of Object.keys(mixin.attributes)) {
          if (key in target.attributes) {
            failures.push(`rule 10: mixin '${d.key}' on '${mixin.entityType}' declares '${key}', which collides with a base attribute of the same key`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // §5.6/§15: PersonFact must default to 'personal' sensitivity, never
  // 'business' — the one sensitivityDefault this parity guard pins by name,
  // because a regression here silently widens what leaves this deployment in
  // prompt enrichment for every PersonFact ever written.
  // ---------------------------------------------------------------------------
  it('pins PersonFact.sensitivityDefault to "personal"', () => {
    const personFact = ONTOLOGY.entityType('PersonFact');
    expect(personFact).toBeDefined();
    expect(personFact?.sensitivityDefault).toBe('personal');
  });

  it('DEFAULT_ENABLED_DOMAINS includes core and work', () => {
    expect(DEFAULT_ENABLED_DOMAINS).toContain('core');
    expect(DEFAULT_ENABLED_DOMAINS).toContain('work');
  });
});

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
  RDF_PREFIXES,
  expandCurie,
  ONTOLOGY_MIGRATIONS,
  checkOntologyMigrations,
} from '@app/shared/ontology';
import type { EntityTypeSpec, OntologyMigration, RelationTypeSpec } from '@app/shared/ontology';

import { buildMigrationTestDefinition } from './fixtures/migration-fixtures';

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
// The first ten rules are numbered exactly as `docs/specs/ontology.md` / issue #350
// numbers them; rule 11 (alignment prefixes) is issue #385's, rules 12–13 are
// #383's, and rules 14–17 (ontology migrations) are #384's. One `it` per rule.
//
// Rules 14–17 live in `checkOntologyMigrations` (packages/shared/src/ontology/
// migrations.ts) rather than inline, so each can ALSO be run against a
// deliberately broken fixture below — proving the rule rejects something,
// which the real (empty at 1.x) ONTOLOGY_MIGRATIONS never could.
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

  it('rule 11: every alignment (type, relation and attribute) is a CURIE whose prefix is a known RDF_PREFIXES entry', () => {
    const failures: string[] = [];
    const known = Object.keys(RDF_PREFIXES).join(', ');
    const check = (where: string, alignment: string | undefined) => {
      if (alignment === undefined) return;
      if (expandCurie(alignment) === undefined) {
        failures.push(`rule 11: ${where} alignment '${alignment}' is not a CURIE with a known prefix (${known}) — see packages/shared/src/ontology/rdf-namespaces.ts`);
      }
    };
    const checkAttrs = (owner: string, attrs: Record<string, { alignment?: string }>) => {
      for (const [key, spec] of Object.entries(attrs)) check(`attribute '${owner}.${key}'`, spec.alignment);
    };

    for (const t of entityTypes) {
      check(`entity type '${t.key}'`, t.alignment);
      checkAttrs(t.key, t.attributes);
    }
    for (const r of relationTypes) {
      check(`relation type '${r.key}'`, r.alignment);
      checkAttrs(r.key, r.props);
    }
    for (const d of ONTOLOGY.domains()) {
      for (const mixin of d.mixins) checkAttrs(mixin.entityType, mixin.attributes);
    }

    expect(failures).toEqual([]);
  });

  it('rule 12 (#383): a symmetric relation names the same single type as from and to, is an edge, and has no allowedPairs', () => {
    const failures: string[] = [];

    for (const r of relationTypes) {
      if (r.symmetric !== true) continue;
      if (r.from.length !== 1 || r.to.length !== 1 || r.from[0] !== r.to[0]) {
        failures.push(`rule 12: symmetric relation '${r.key}' has from [${r.from.join(', ')}] and to [${r.to.join(', ')}], not one same type`);
      }
      if (r.representation.kind !== 'edge') {
        failures.push(`rule 12: symmetric relation '${r.key}' is represented as '${r.representation.kind}', not 'edge'`);
      }
      if (r.allowedPairs !== undefined) {
        failures.push(`rule 12: symmetric relation '${r.key}' declares allowedPairs`);
      }
    }
    expect(relationTypes.filter((r) => r.symmetric === true).map((r) => r.key)).toEqual(['SPOUSE_OF', 'FRIEND_OF']);

    expect(failures).toEqual([]);
  });

  it('rule 13 (#383, §17.2): every personal-domain type and relation defaults to "personal" sensitivity, and the domain is off by default', () => {
    const failures: string[] = [];
    const personal = ONTOLOGY.domains().find((d) => d.key === 'personal');

    if (personal === undefined) failures.push("rule 13: the 'personal' domain is not registered");
    if (personal?.defaultEnabled !== false) failures.push("rule 13: the 'personal' domain must be off by default");
    for (const t of entityTypes.filter((x) => x.domain === 'personal')) {
      if (t.sensitivityDefault !== 'personal') {
        failures.push(`rule 13: personal type '${t.key}' has sensitivityDefault '${t.sensitivityDefault}', not 'personal'`);
      }
    }
    for (const r of relationTypes.filter((x) => x.domain === 'personal')) {
      if (r.sensitivityDefault !== 'personal') {
        failures.push(`rule 13: personal relation '${r.key}' has sensitivityDefault '${String(r.sensitivityDefault)}', not 'personal'`);
      }
    }
    if ((DEFAULT_ENABLED_DOMAINS as readonly string[]).includes('personal')) {
      failures.push("rule 13: DEFAULT_ENABLED_DOMAINS must not include 'personal'");
    }

    expect(failures).toEqual([]);
  });

  it('rules 14–17 (#384, §17.4): the shipped ONTOLOGY_MIGRATIONS are sound — every `to` in the CHANGELOG and ascending, retag/rename/drop sources retired and targets declared, retags only in a major bump, no user attribute keys', () => {
    expect(
      checkOntologyMigrations({ migrations: ONTOLOGY_MIGRATIONS, registry: ONTOLOGY, changelog: CHANGELOG, shippedKeys: SHIPPED_KEYS }),
    ).toEqual([]);
  });

  describe('rules 14–17 reject broken migrations (fixture registry)', () => {
    const def = buildMigrationTestDefinition();
    const check = (migrations: OntologyMigration[]) =>
      checkOntologyMigrations({ migrations, registry: def.registry, changelog: def.changelog, shippedKeys: def.shippedKeys });
    const rules = (failures: string[]) => failures.map((f) => f.split(':')[0]);

    it('accepts the acceptance fixture itself', () => {
      expect(check(def.migrations)).toEqual([]);
    });

    it('rule 14: a migration `to` missing from the CHANGELOG', () => {
      const failures = check([{ ...def.migrations[0], to: '1.2.0' }]);
      expect(rules(failures)).toContain('rule 14');
      expect(failures.join('\n')).toMatch(/1\.2\.0.*no CHANGELOG entry/);
    });

    it('rule 14: migrations out of order, and a pre-release version', () => {
      expect(rules(check([def.migrations[1], def.migrations[0]]))).toContain('rule 14');
      expect(rules(check([{ ...def.migrations[0], to: '1.1.0-rc.1' }]))).toContain('rule 14');
    });

    it('rule 15: a retag from a non-deprecated key', () => {
      const failures = check([
        { to: '2.0.0', description: 'bad', steps: [{ op: 'retag_entity_type', from: 'Project', to: 'NewType' }] },
      ]);
      expect(failures).toEqual([expect.stringMatching(/^rule 15: .*source 'Project' is not deprecated/)]);
    });

    it('rule 15: a rename/drop of a live attribute, a rename to an undeclared one, a coerce against the declared kind', () => {
      const failures = check([
        {
          to: '1.1.0',
          description: 'bad',
          steps: [
            { op: 'rename_attribute', typeKey: 'Project', from: 'endDate', to: 'finish' },
            { op: 'drop_attribute', typeKey: 'Project', key: 'status' },
            { op: 'coerce_attribute', typeKey: 'Project', key: 'status', to: 'text' },
          ],
        },
      ]);
      expect(failures).toEqual([
        expect.stringMatching(/^rule 15: .*'Project\.endDate' is not deprecated/),
        expect.stringMatching(/^rule 15: .*'Project\.finish' is not declared/),
        expect.stringMatching(/^rule 15: .*'Project\.status' is not deprecated/),
        expect.stringMatching(/^rule 15: .*declared 'select'/),
      ]);
    });

    it('rule 15: a coerce map onto a value that is not a choice, and a status retag onto an undeclared status', () => {
      const failures = check([
        {
          to: '1.1.0',
          description: 'bad',
          steps: [
            { op: 'coerce_attribute', typeKey: 'Project', key: 'status', to: 'select', map: { Active: 'active', Paused: 'paused' } },
            { op: 'retag_item_status', itemKind: 'commitment', from: 'open', to: 'pending' },
          ],
        },
      ]);
      expect(failures).toEqual([
        expect.stringMatching(/^rule 15: .*maps to 'paused'/),
        expect.stringMatching(/^rule 15: .*'pending' is not a status of 'Commitment'/),
      ]);
    });

    it('rule 16: a type retag in a minor bump', () => {
      const failures = check([
        { to: '1.1.0', description: 'bad', steps: [{ op: 'retag_entity_type', from: 'OldType', to: 'NewType' }] },
      ]);
      expect(rules(failures)).toEqual(['rule 16']);
    });

    it('rule 17: a step on a u_* attribute', () => {
      const failures = check([
        { to: '1.1.0', description: 'bad', steps: [{ op: 'drop_attribute', typeKey: 'Project', key: 'u_abcdefghij' }] },
      ]);
      expect(rules(failures)).toEqual(['rule 17']);
    });
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

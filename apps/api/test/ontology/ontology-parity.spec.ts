/**
 * Ontology parity test (issue #350, docs/specs/ontology.md §17.4).
 *
 * The properties that keep the definition file (`@app/shared/ontology`)
 * internally honest, in the style of `settings-parity.spec.ts`: one `it` per
 * rule, and every failure message names the key and the rule it broke, so a
 * red run says what to fix without opening the file.
 *
 * Rule 4 is the data-integrity control: a key that ever shipped is never
 * removed (only deprecated), enforced against the append-only SHIPPED_KEYS
 * ledger in `packages/shared/src/ontology/shipped-keys.ts`.
 */
import {
  ATTRIBUTE_KINDS,
  type AttributeSpec,
  CHANGELOG,
  ITEM_KINDS,
  ONTOLOGY,
  ONTOLOGY_VERSION,
  PSEUDO_TYPES,
  SHIPPED_KEYS,
  USER_ATTRIBUTE_KEY_PREFIX,
  OntologyDefinitionError,
  buildOntologyRegistry,
  computeEffectiveSchema,
  defineDomain,
  defineEntityType,
  defineRelationType,
  type EntityTypeSpec,
  type RelationTypeSpec,
} from '@app/shared/ontology';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const entityTypes = ONTOLOGY.entityTypes();
const relationTypes = ONTOLOGY.relationTypes();
const entityKeys = new Set(entityTypes.map((t) => t.key));
const pseudoTypes = new Set<string>(PSEUDO_TYPES);

/** Every `[owner.key, spec]` attribute: built-ins, mixins and relation props. */
function allAttributes(): [string, AttributeSpec][] {
  const out: [string, AttributeSpec][] = [];
  for (const t of entityTypes) for (const [k, s] of Object.entries(t.attributes)) out.push([`${t.key}.${k}`, s]);
  for (const mod of ONTOLOGY.domains()) {
    for (const mixin of mod.mixins) {
      for (const [k, s] of Object.entries(mixin.attributes)) out.push([`${mixin.entityType}.${k}`, s]);
    }
  }
  for (const r of relationTypes) for (const [k, s] of Object.entries(r.props)) out.push([`${r.key}.${k}`, s]);
  return out;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

describe('ontology parity (@app/shared/ontology)', () => {
  it('ships exactly the v1 type and relation set', () => {
    expect(entityTypes.map((t) => t.key)).toEqual([
      'Person',
      'Organization',
      'Meeting',
      'Claim',
      'PersonFact',
      'Project',
      'Commitment',
      'Decision',
    ]);
    expect([...relationTypes.map((r) => r.key)].sort()).toEqual(
      [
        'WORKS_FOR',
        'HAS_ROLE',
        'REPORTS_TO',
        'ATTENDED',
        'DISCUSSED',
        'PART_OF',
        'ABOUT',
        'ASSIGNED_TO',
        'OWED_TO',
        'CREATED_IN',
        'DECIDED_IN',
        'IDENTIFIED_AS',
        'SUPERSEDES',
        'MENTIONS',
        'SUPPORTED_BY',
      ].sort(),
    );
  });

  it('rule 1: every type has a label and a description of at least 20 characters, and every entity type a disambiguation rule', () => {
    const problems: string[] = [];
    for (const t of [...entityTypes, ...relationTypes]) {
      if (!t.label?.trim()) problems.push(`${t.key}: missing label`);
      if ((t.description ?? '').trim().length < 20) problems.push(`${t.key}: description shorter than 20 characters`);
    }
    for (const t of entityTypes) {
      if (t.disambiguation.length < 1) problems.push(`${t.key}: needs at least one disambiguation rule`);
      for (const rule of t.disambiguation) if (!rule.trim()) problems.push(`${t.key}: empty disambiguation rule`);
    }
    for (const [name, spec] of allAttributes()) {
      if (!spec.label?.trim()) problems.push(`${name}: missing label`);
      if ((spec.description ?? '').trim().length < 20) problems.push(`${name}: description shorter than 20 characters`);
    }
    expect(problems).toEqual([]);
  });

  it('rule 2: relation endpoints are non-empty, registered or pseudo, pseudo only where allowed, and allowedPairs ⊆ from × to', () => {
    const problems: string[] = [];
    for (const r of relationTypes) {
      if (r.from.length === 0) problems.push(`${r.key}: empty from`);
      if (r.to.length === 0) problems.push(`${r.key}: empty to`);
      const pseudoAllowed = ['speaker_link', 'mention', 'evidence'].includes(r.representation.kind);
      for (const endpoint of [...r.from, ...r.to]) {
        if (entityKeys.has(endpoint)) continue;
        if (!pseudoTypes.has(endpoint)) problems.push(`${r.key}: endpoint '${endpoint}' is not a registered type`);
        else if (!pseudoAllowed) {
          problems.push(`${r.key}: pseudo-type '${endpoint}' used in a ${r.representation.kind} relation`);
        }
      }
      for (const [from, to] of r.allowedPairs ?? []) {
        if (!r.from.includes(from) || !r.to.includes(to)) {
          problems.push(`${r.key}: allowed pair [${from}, ${to}] is not within from × to`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('rule 3: every attribute has a known kind; selects have unique choices; entity_ref targets resolve', () => {
    const problems: string[] = [];
    for (const [name, spec] of allAttributes()) {
      if (!(ATTRIBUTE_KINDS as readonly string[]).includes(spec.kind)) problems.push(`${name}: unknown kind '${spec.kind}'`);
      if (spec.kind === 'select' || spec.kind === 'multi_select') {
        const values = (spec.options?.choices ?? []).map((c) => c.value);
        if (values.length < 1) problems.push(`${name}: ${spec.kind} needs at least one choice`);
        if (new Set(values).size !== values.length) problems.push(`${name}: duplicate choice values`);
      }
      for (const target of spec.options?.targetTypes ?? []) {
        if (!entityKeys.has(target)) problems.push(`${name}: entity_ref target '${target}' does not resolve`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('rule 4: no shipped key is ever removed, and every registry key is recorded in SHIPPED_KEYS', () => {
    const registryKeys = new Set<string>();
    for (const t of entityTypes) registryKeys.add(t.key);
    for (const r of relationTypes) registryKeys.add(r.key);
    for (const [name] of allAttributes()) registryKeys.add(name);

    const shipped = new Set(SHIPPED_KEYS);
    expect(shipped.size).toBe(SHIPPED_KEYS.length);

    const removed = SHIPPED_KEYS.filter((k) => !registryKeys.has(k)).map(
      (k) => `${k}: shipped but no longer in the registry (deprecate it, never delete it)`,
    );
    const unrecorded = [...registryKeys]
      .filter((k) => !shipped.has(k))
      .map((k) => `${k}: in the registry but missing from SHIPPED_KEYS (append it to shipped-keys.ts)`);
    expect([...removed, ...unrecorded]).toEqual([]);
  });

  it('rule 5: key formats — types PascalCase, relations SCREAMING_SNAKE, attributes camelCase, none starting u_', () => {
    const problems: string[] = [];
    for (const t of entityTypes) if (!/^[A-Z][A-Za-z]+$/.test(t.key)) problems.push(`${t.key}: bad entity type key`);
    for (const r of relationTypes) if (!/^[A-Z][A-Z_]+$/.test(r.key)) problems.push(`${r.key}: bad relation type key`);
    for (const [name] of allAttributes()) {
      const key = name.slice(name.indexOf('.') + 1);
      if (key.startsWith(USER_ATTRIBUTE_KEY_PREFIX)) problems.push(`${name}: starts with the user-attribute prefix`);
      if (!/^[a-z][A-Za-z0-9]*$/.test(key)) problems.push(`${name}: bad attribute key`);
    }
    expect(problems).toEqual([]);
  });

  it("rule 6: exclusive 'soft' implies temporal, and temporal implies an edge", () => {
    const problems: string[] = [];
    for (const r of relationTypes) {
      if (r.exclusive === 'soft' && !r.temporal) problems.push(`${r.key}: exclusive 'soft' without temporal`);
      if (r.temporal && r.representation.kind !== 'edge') problems.push(`${r.key}: temporal but not an edge`);
    }
    expect(problems).toEqual([]);
    expect(ONTOLOGY.relationType('HAS_ROLE')?.exclusiveScope).toBe('from_to');
  });

  it('rule 7: item types carry itemKind, statuses and subjectTypes; each ITEM_KIND is used exactly once', () => {
    const problems: string[] = [];
    const used = new Map<string, string[]>();
    for (const t of entityTypes) {
      if (t.itemKind === undefined) continue;
      used.set(t.itemKind, [...(used.get(t.itemKind) ?? []), t.key]);
      if (!t.statuses || t.statuses.length === 0) problems.push(`${t.key}: item type without statuses`);
      if (!t.subjectTypes || t.subjectTypes.length === 0) problems.push(`${t.key}: item type without subjectTypes`);
    }
    for (const kind of ITEM_KINDS) {
      const owners = used.get(kind) ?? [];
      if (owners.length !== 1) problems.push(`itemKind '${kind}': used by ${owners.length} types (${owners.join(', ')})`);
    }
    expect(problems).toEqual([]);
  });

  it('pins PersonFact to personal sensitivity (§5.6, §15), never business', () => {
    expect(ONTOLOGY.entityType('PersonFact')?.sensitivityDefault).toBe('personal');
  });

  it('rule 8: ONTOLOGY_VERSION is semver, equals the last CHANGELOG entry, and versions strictly increase', () => {
    expect(ONTOLOGY_VERSION).toMatch(SEMVER);
    expect(CHANGELOG.length).toBeGreaterThan(0);
    expect(CHANGELOG[CHANGELOG.length - 1].version).toBe(ONTOLOGY_VERSION);
    expect(ONTOLOGY.version).toBe(ONTOLOGY_VERSION);
    const problems: string[] = [];
    CHANGELOG.forEach((entry, i) => {
      if (!SEMVER.test(entry.version)) problems.push(`CHANGELOG[${i}] ${entry.version}: not semver`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) problems.push(`CHANGELOG[${i}] ${entry.version}: date not YYYY-MM-DD`);
      if (entry.changes.length === 0) problems.push(`CHANGELOG[${i}] ${entry.version}: no changes listed`);
      if (i > 0 && compareSemver(CHANGELOG[i - 1].version, entry.version) >= 0) {
        problems.push(`CHANGELOG[${i}] ${entry.version}: does not increase over ${CHANGELOG[i - 1].version}`);
      }
    });
    expect(problems).toEqual([]);
    expect(CHANGELOG[0].version).toBe('1.0.0');
  });

  it('rule 9: the core-only effective schema has no dangling endpoint', () => {
    const schema = computeEffectiveSchema({ enabledDomains: [], userAttributes: [] });
    const present = new Set([...schema.entityTypes.map((t) => t.key), ...PSEUDO_TYPES]);
    const problems: string[] = [];
    for (const r of schema.relationTypes) {
      for (const endpoint of [...r.from, ...r.to]) {
        if (!present.has(endpoint)) problems.push(`${r.key}: dangling endpoint '${endpoint}' in the core-only schema`);
      }
      for (const [f, t] of r.allowedPairs ?? []) {
        if (!present.has(f) || !present.has(t)) problems.push(`${r.key}: dangling allowed pair [${f}, ${t}]`);
      }
    }
    for (const t of schema.entityTypes) {
      for (const s of t.subjectTypes ?? []) {
        if (!present.has(s)) problems.push(`${t.key}: dangling subject type '${s}' in the core-only schema`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('rule 10: mixin keys never collide with a base attribute key (or another mixin)', () => {
    const problems: string[] = [];
    const seen = new Map<string, string>();
    for (const t of entityTypes) for (const k of Object.keys(t.attributes)) seen.set(`${t.key}.${k}`, `base ${t.key}`);
    for (const mod of ONTOLOGY.domains()) {
      for (const mixin of mod.mixins) {
        if (!entityKeys.has(mixin.entityType)) problems.push(`mixin from ${mod.key}: unknown type '${mixin.entityType}'`);
        for (const k of Object.keys(mixin.attributes)) {
          const name = `${mixin.entityType}.${k}`;
          const owner = seen.get(name);
          if (owner) problems.push(`${name}: mixin from '${mod.key}' collides with ${owner}`);
          seen.set(name, `the '${mod.key}' mixin`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('definition-time validation (define.ts, registry.ts)', () => {
  const entity = (over: Partial<EntityTypeSpec> = {}): EntityTypeSpec => ({
    key: 'Widget',
    domain: 'core',
    label: 'Widget',
    pluralLabel: 'Widgets',
    description: 'A test-only entity type used to exercise the factories.',
    disambiguation: ['Only ever used by this test.'],
    attributes: {},
    sensitivityDefault: 'business',
    ...over,
  });
  const relation = (over: Partial<RelationTypeSpec> = {}): RelationTypeSpec => ({
    key: 'LINKS_TO',
    domain: 'core',
    label: 'Links to',
    description: 'A test-only relation used to exercise the factories.',
    from: ['Person'],
    to: ['Person'],
    temporal: false,
    exclusive: 'none',
    props: {},
    representation: { kind: 'edge' },
    extractable: true,
    ...over,
  });

  it('accepts a well-formed declaration and freezes it', () => {
    const def = defineEntityType(entity());
    expect(Object.isFrozen(def)).toBe(true);
    expect(Object.isFrozen(def.disambiguation)).toBe(true);
  });

  it('throws on an empty description', () => {
    expect(() => defineEntityType(entity({ description: '  ' }))).toThrow(OntologyDefinitionError);
    expect(() => defineEntityType(entity({ description: '' }))).toThrow(/Widget: description must not be empty/);
  });

  it('throws on a relation with from: []', () => {
    expect(() => defineRelationType(relation({ from: [] }))).toThrow(/LINKS_TO: from must name at least one/);
  });

  it('throws on an attribute without a kind', () => {
    const attributes = { size: { label: 'Size', description: 'How big the widget is.' } } as unknown as EntityTypeSpec['attributes'];
    expect(() => defineEntityType(entity({ attributes }))).toThrow(/Widget\.size: kind must be one of/);
  });

  it('throws on an attribute key starting u_', () => {
    const attributes = { u_x: { kind: 'text' as const, label: 'X', description: 'Reserved prefix.' } };
    expect(() => defineEntityType(entity({ attributes }))).toThrow(/Widget\.u_x: attribute keys starting 'u_' are reserved/);
  });

  it('throws on a bad key format, a choice-less select, and soft exclusivity without temporal', () => {
    expect(() => defineEntityType(entity({ key: 'widget' }))).toThrow(OntologyDefinitionError);
    expect(() => defineRelationType(relation({ key: 'LinksTo' }))).toThrow(OntologyDefinitionError);
    const attributes = { tier: { kind: 'select' as const, label: 'Tier', description: 'Pick one.', options: { choices: [] } } };
    expect(() => defineEntityType(entity({ attributes }))).toThrow(/Widget\.tier: a select attribute needs at least one choice/);
    expect(() => defineRelationType(relation({ exclusive: 'soft' }))).toThrow(/LINKS_TO: exclusive 'soft' requires temporal/);
  });

  it('buildOntologyRegistry throws on a duplicate key, a dangling endpoint and a bad version', () => {
    const [core, work] = ONTOLOGY.domains();
    expect(() => buildOntologyRegistry([core, work], 'v1')).toThrow(/not semver/);
    expect(() => buildOntologyRegistry([core, core], '1.0.0')).toThrow(/Duplicate domain module 'core'/);
    // core alone: Claim's subject types and ABOUT/SUPERSEDES/SUPPORTED_BY name work-domain types.
    expect(() => buildOntologyRegistry([core], '1.0.0')).toThrow(/Project' is not a registered entity type/);
    const ghost = defineDomain({
      key: 'personal',
      label: 'Personal',
      alwaysOn: false,
      defaultEnabled: false,
      entityTypes: [],
      relationTypes: [defineRelationType(relation({ domain: 'personal', to: ['Ghost'] }))],
      mixins: [],
    });
    expect(() => buildOntologyRegistry([core, work, ghost], '1.0.0')).toThrow(
      /LINKS_TO: endpoint 'Ghost' .*dangling endpoint/,
    );
    const dup = defineDomain({
      key: 'personal',
      label: 'Personal',
      alwaysOn: false,
      defaultEnabled: false,
      entityTypes: [defineEntityType(entity({ key: 'Person', domain: 'personal' }))],
      relationTypes: [],
      mixins: [],
    });
    expect(() => buildOntologyRegistry([core, work, dup], '1.0.0')).toThrow(/Duplicate entity type key 'Person'/);
  });
});

/**
 * Strict JSON Schema building blocks (issue #350). A recursive walker asserts
 * the strict structured-output subset on every extractable entity type's and
 * every extractable relation's `props` schema:
 *
 *   - root `type: 'object'`; every object `additionalProperties: false` with
 *     `required` equal to `Object.keys(properties)`;
 *   - only the allowed keywords, never a forbidden one;
 *   - nesting depth <= 5 from the props root.
 *
 * Cross-check pending: once #358's `assertStrictJsonSchema()`
 * (`apps/api/src/ai/structured/strict-json-schema.ts`) is on main, whichever
 * of #350/#358 merges second also calls it on every output below.
 */
import {
  type EffectiveSchema,
  type UserAttributeDef,
  buildPropsJsonSchema,
  buildPropsSchema,
  computeEffectiveSchema,
  extractableEntityTypes,
  extractableRelationTypes,
} from '@app/shared/ontology';

const ALLOWED = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf', 'description']);
const FORBIDDEN = ['format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'const', '$ref', 'default', 'minItems', 'maxItems'];
const MAX_DEPTH = 5;

type Node = Record<string, unknown>;

/** Walks a schema; returns every violation as `<type>:<json path>: <rule>`. */
function violations(owner: string, node: Node, path = '$', depth = 0): string[] {
  const out: string[] = [];
  const where = `${owner}:${path}`;
  if (depth > MAX_DEPTH) out.push(`${where}: nesting deeper than ${MAX_DEPTH}`);
  for (const key of Object.keys(node)) {
    if (!ALLOWED.has(key)) out.push(`${where}: keyword '${key}' is not in the strict subset`);
  }
  for (const key of FORBIDDEN) if (key in node) out.push(`${where}: forbidden keyword '${key}'`);

  const types = Array.isArray(node.type) ? node.type : node.type !== undefined ? [node.type] : [];
  if (types.includes('object')) {
    const properties = (node.properties ?? {}) as Record<string, Node>;
    if (node.additionalProperties !== false) out.push(`${where}: object without additionalProperties: false`);
    if (JSON.stringify(node.required) !== JSON.stringify(Object.keys(properties))) {
      out.push(`${where}: required must list every property key, in order`);
    }
    for (const [key, child] of Object.entries(properties)) out.push(...violations(owner, child, `${path}.${key}`, depth + 1));
  }
  if (node.type === undefined && node.anyOf === undefined) out.push(`${where}: neither type nor anyOf`);
  if (Array.isArray(node.anyOf)) {
    (node.anyOf as Node[]).forEach((child, i) => out.push(...violations(owner, child, `${path}.anyOf[${i}]`, depth + 1)));
  }
  if (node.items !== undefined) out.push(...violations(owner, node.items as Node, `${path}.items`, depth + 1));
  return out;
}

function allOutputs(schema: EffectiveSchema): [string, Node][] {
  return [
    ...extractableEntityTypes(schema).map((k): [string, Node] => [k, buildPropsJsonSchema(schema, k)]),
    ...extractableRelationTypes(schema).map((k): [string, Node] => [k, buildPropsJsonSchema(schema, k, { relation: true })]),
  ];
}

const userAttributes: UserAttributeDef[] = [
  ['text', null],
  ['number', null],
  ['date', null],
  ['boolean', null],
  ['select', { choices: [{ value: 'x', label: 'X' }] }],
  ['multi_select', { choices: [{ value: 'y', label: 'Y' }] }],
  ['url', null],
  ['entity_ref', { targetTypes: ['Person'] }],
].map(([kind, options], i) => ({
  id: `def-${i}`,
  entityType: 'Organization',
  key: `u_kind${String(i).padStart(6, '0')}`,
  label: String(kind),
  kind: kind as UserAttributeDef['kind'],
  options: options as UserAttributeDef['options'],
  extractable: true,
  extractionHint: `Extraction hint for the ${String(kind)} attribute`,
  sensitivity: null,
  sortOrder: i,
  deprecatedAt: null,
}));

describe('buildPropsJsonSchema', () => {
  const full = computeEffectiveSchema({ enabledDomains: ['work'], userAttributes });
  const coreOnly = computeEffectiveSchema({ enabledDomains: [], userAttributes: [] });

  it('lists the extractable types (Meeting and non-edge relations excluded)', () => {
    expect(extractableEntityTypes(full)).toEqual(['Person', 'Organization', 'Claim', 'PersonFact', 'Project', 'Commitment', 'Decision']);
    expect(extractableRelationTypes(full)).toEqual(['WORKS_FOR', 'HAS_ROLE', 'REPORTS_TO', 'ATTENDED', 'DISCUSSED', 'PART_OF']);
    expect(extractableRelationTypes(coreOnly)).toEqual([]);
  });

  it.each([
    ['core + work (with one user attribute of every kind)', full],
    ['core only', coreOnly],
  ])('every output obeys the strict rules: %s', (_label, schema) => {
    const problems: string[] = [];
    for (const [owner, json] of allOutputs(schema)) {
      if (json.type !== 'object') problems.push(`${owner}: root is not type object`);
      problems.push(...violations(owner, json));
    }
    expect(problems).toEqual([]);
  });

  it('makes optional attributes nullable and a required prop non-nullable', () => {
    const project = buildPropsJsonSchema(full, 'Project') as { properties: Record<string, Node> };
    expect(project.properties.startDate.type).toEqual(['string', 'null']);
    expect(project.properties.status.anyOf).toEqual([
      { type: 'string', enum: ['planned', 'active', 'done', 'cancelled'] },
      { type: 'null' },
    ]);
    const hasRole = buildPropsJsonSchema(full, 'HAS_ROLE', { relation: true }) as {
      properties: Record<string, Node>;
      required: string[];
    };
    expect(hasRole.properties.title.type).toBe('string');
    expect(hasRole.required).toEqual(['title']);
  });

  it('describes user attributes with their extraction hint', () => {
    const org = buildPropsJsonSchema(full, 'Organization') as { properties: Record<string, Node> };
    expect(String(org.properties.u_kind000000.description)).toContain('Extraction hint for the text attribute');
    expect(Object.keys(org.properties)).toEqual(['website', ...userAttributes.map((d) => d.key)]);
  });

  it('agrees with the extract-purpose Zod schema on which keys exist', () => {
    for (const [owner, json] of allOutputs(full)) {
      const relation = full.relationTypeByKey.has(owner);
      const zod = buildPropsSchema(full, owner, { purpose: 'extract', relation });
      const properties = json.properties as Record<string, Node>;
      // "Not stated" for every optional key; a plain string for a required
      // (non-nullable) text key. Every key the JSON Schema offers must parse.
      const probe = Object.fromEntries(
        Object.entries(properties).map(([k, p]) => [k, p.type === 'string' ? 'stated value' : null]),
      );
      expect({ owner, ok: zod.safeParse(probe).success }).toEqual({ owner, ok: true });
      expect(zod.safeParse({ ...probe, notDeclared: 1 }).success).toBe(false);
    }
  });
});

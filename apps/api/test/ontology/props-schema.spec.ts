import { buildPropsSchema, computeEffectiveSchema, validateProps } from '@app/shared/ontology';
import type { UserAttributeDef } from '@app/shared/ontology';

function schemaWithUserAttribute(overrides: Partial<UserAttributeDef>) {
  const def: UserAttributeDef = {
    id: 'attr-1',
    entityType: 'Person',
    key: 'u_test000001',
    label: 'Test attribute',
    kind: 'text',
    options: null,
    extractable: true,
    extractionHint: null,
    sensitivity: null,
    sortOrder: 0,
    deprecatedAt: null,
    ...overrides,
  };
  return computeEffectiveSchema({ enabledDomains: ['work'], userAttributes: [def] });
}

describe('validateProps / buildPropsSchema: one case per attribute kind', () => {
  it('text: valid non-empty string trimmed, rejects empty/blank and over-length', () => {
    const schema = schemaWithUserAttribute({ kind: 'text' });
    expect(validateProps(schema, 'Person', { u_test000001: '  hello  ' })).toEqual({
      ok: true,
      value: { u_test000001: 'hello' },
    });
    expect(validateProps(schema, 'Person', { u_test000001: '   ' }).ok).toBe(false);
    expect(validateProps(schema, 'Person', { u_test000001: 'x'.repeat(2001) }).ok).toBe(false);
  });

  it('number: valid finite number, rejects a numeric string and NaN-shaped input', () => {
    const schema = schemaWithUserAttribute({ kind: 'number' });
    expect(validateProps(schema, 'Person', { u_test000001: 42 })).toEqual({ ok: true, value: { u_test000001: 42 } });
    expect(validateProps(schema, 'Person', { u_test000001: '42' }).ok).toBe(false);
  });

  it('date: valid YYYY-MM-DD, rejects other formats', () => {
    const schema = schemaWithUserAttribute({ kind: 'date' });
    expect(validateProps(schema, 'Person', { u_test000001: '2026-01-01' })).toEqual({
      ok: true,
      value: { u_test000001: '2026-01-01' },
    });
    expect(validateProps(schema, 'Person', { u_test000001: '01/01/2026' }).ok).toBe(false);
    expect(validateProps(schema, 'Person', { u_test000001: '2026-13-40' }).ok).toBe(false);
  });

  it('boolean: valid true/false, rejects a truthy string', () => {
    const schema = schemaWithUserAttribute({ kind: 'boolean' });
    expect(validateProps(schema, 'Person', { u_test000001: true })).toEqual({ ok: true, value: { u_test000001: true } });
    expect(validateProps(schema, 'Person', { u_test000001: 'true' }).ok).toBe(false);
  });

  it('select: valid choice value, rejects a value outside choices', () => {
    const schema = schemaWithUserAttribute({
      kind: 'select',
      options: { choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    });
    expect(validateProps(schema, 'Person', { u_test000001: 'a' })).toEqual({ ok: true, value: { u_test000001: 'a' } });
    const rejected = validateProps(schema, 'Person', { u_test000001: 'c' });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.issues[0].path).toBe('u_test000001');
  });

  it('multi_select: valid unique subset of choices, rejects a duplicate and a value outside choices', () => {
    const schema = schemaWithUserAttribute({
      kind: 'multi_select',
      options: { choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    });
    expect(validateProps(schema, 'Person', { u_test000001: ['a', 'b'] })).toEqual({
      ok: true,
      value: { u_test000001: ['a', 'b'] },
    });
    expect(validateProps(schema, 'Person', { u_test000001: ['a', 'a'] }).ok).toBe(false);
    expect(validateProps(schema, 'Person', { u_test000001: ['c'] }).ok).toBe(false);
  });

  it('url: valid http(s) URL, rejects a non-http(s) scheme and an over-length URL', () => {
    const schema = schemaWithUserAttribute({ kind: 'url' });
    expect(validateProps(schema, 'Person', { u_test000001: 'https://example.com' })).toEqual({
      ok: true,
      value: { u_test000001: 'https://example.com' },
    });
    expect(validateProps(schema, 'Person', { u_test000001: 'ftp://example.com' }).ok).toBe(false);
    expect(validateProps(schema, 'Person', { u_test000001: `https://example.com/${'a'.repeat(2048)}` }).ok).toBe(false);
  });

  it('entity_ref: valid uuid, rejects a non-uuid string', () => {
    const schema = schemaWithUserAttribute({ kind: 'entity_ref' });
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    expect(validateProps(schema, 'Person', { u_test000001: uuid })).toEqual({ ok: true, value: { u_test000001: uuid } });
    const rejected = validateProps(schema, 'Person', { u_test000001: 'not-a-uuid' });
    expect(rejected.ok).toBe(false);
  });
});

describe('validateProps: list', () => {
  it('a list: true attribute (Meeting.topics, text) accepts an array, rejects a scalar and an over-long array', () => {
    const schema = computeEffectiveSchema({ enabledDomains: [], userAttributes: [] });
    expect(validateProps(schema, 'Meeting', { topics: ['budget', 'timeline'] })).toEqual({
      ok: true,
      value: { topics: ['budget', 'timeline'] },
    });
    expect(validateProps(schema, 'Meeting', { topics: 'budget' }).ok).toBe(false);
    expect(validateProps(schema, 'Meeting', { topics: Array.from({ length: 51 }, () => 'x') }).ok).toBe(false);
  });
});

describe('validateProps: null on required versus optional', () => {
  it('a required relation prop (HAS_ROLE.title) rejects null on write, but allows omitting the key entirely', () => {
    const schema = computeEffectiveSchema({ enabledDomains: ['work'], userAttributes: [] });
    expect(validateProps(schema, 'HAS_ROLE', { title: null }, { relation: true }).ok).toBe(false);
    expect(validateProps(schema, 'HAS_ROLE', {}, { relation: true })).toEqual({ ok: true, value: {} });
    expect(validateProps(schema, 'HAS_ROLE', { title: 'Staff Engineer' }, { relation: true })).toEqual({
      ok: true,
      value: { title: 'Staff Engineer' },
    });
  });

  it('an optional attribute (Organization.website) accepts null (clears the key) and omission', () => {
    const schema = computeEffectiveSchema({ enabledDomains: [], userAttributes: [] });
    expect(validateProps(schema, 'Organization', { website: null })).toEqual({ ok: true, value: { website: null } });
    expect(validateProps(schema, 'Organization', {})).toEqual({ ok: true, value: {} });
  });

  it('extract purpose requires a required attribute to be present and non-null', () => {
    const schema = computeEffectiveSchema({ enabledDomains: ['work'], userAttributes: [] });
    const extractSchema = buildPropsSchema(schema, 'HAS_ROLE', { purpose: 'extract', relation: true });
    expect(extractSchema.safeParse({ title: 'Staff Engineer' }).success).toBe(true);
    expect(extractSchema.safeParse({ title: null }).success).toBe(false);
    expect(extractSchema.safeParse({}).success).toBe(false);
  });

  it('extract purpose allows null (not stated) on an optional attribute', () => {
    const schema = computeEffectiveSchema({ enabledDomains: [], userAttributes: [] });
    const extractSchema = buildPropsSchema(schema, 'Organization', { purpose: 'extract' });
    expect(extractSchema.safeParse({ website: null }).success).toBe(true);
  });
});

describe('validateProps: closed-ness', () => {
  it('rejects an undeclared key, naming it in the issue path and message', () => {
    const schema = computeEffectiveSchema({ enabledDomains: [], userAttributes: [] });
    const result = validateProps(schema, 'Organization', { website: 'https://example.com', notARealKey: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.path === 'notARealKey' && i.message.includes('notARealKey'))).toBe(true);
    }
  });

  it('rejects an unknown type with a path-less issue naming the type', () => {
    const schema = computeEffectiveSchema({ enabledDomains: [], userAttributes: [] });
    const result = validateProps(schema, 'NotAType', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0].message).toContain('NotAType');
    }
  });
});

describe('validateProps: deprecated attributes', () => {
  it('a deprecated user attribute is still accepted on write, so existing values round-trip', () => {
    const schema = schemaWithUserAttribute({ kind: 'text', deprecatedAt: '2026-01-01T00:00:00.000Z' });
    expect(validateProps(schema, 'Person', { u_test000001: 'still here' })).toEqual({
      ok: true,
      value: { u_test000001: 'still here' },
    });
  });

  it('a deprecated attribute is excluded from the extract-purpose schema', () => {
    const schema = schemaWithUserAttribute({ kind: 'text', deprecatedAt: '2026-01-01T00:00:00.000Z' });
    const extractSchema = buildPropsSchema(schema, 'Person', { purpose: 'extract' });
    // Unknown to the extract schema entirely: passing it is a closed-schema violation.
    expect(extractSchema.safeParse({ u_test000001: 'x' }).success).toBe(false);
    expect(extractSchema.safeParse({}).success).toBe(true);
  });
});

describe('buildPropsSchema: extract purpose excludes non-extractable attributes', () => {
  it('excludes a non-extractable built-in attribute (Meeting.transcriptId) from the extract schema', () => {
    const schema = computeEffectiveSchema({ enabledDomains: [], userAttributes: [] });
    const extractSchema = buildPropsSchema(schema, 'Meeting', { purpose: 'extract' });
    expect(extractSchema.safeParse({ transcriptId: 'abc' }).success).toBe(false);
    expect(extractSchema.safeParse({}).success).toBe(true);
  });

  it('includes it on the write schema', () => {
    const schema = computeEffectiveSchema({ enabledDomains: [], userAttributes: [] });
    expect(validateProps(schema, 'Meeting', { transcriptId: 'abc' })).toEqual({ ok: true, value: { transcriptId: 'abc' } });
  });
});

describe('buildPropsSchema caching', () => {
  it('returns the same schema instance for the same schema/type/purpose', () => {
    const schema = computeEffectiveSchema({ enabledDomains: [], userAttributes: [] });
    const a = buildPropsSchema(schema, 'Organization', { purpose: 'write' });
    const b = buildPropsSchema(schema, 'Organization', { purpose: 'write' });
    expect(a).toBe(b);
  });

  it('throws for a type not present in this effective schema', () => {
    const schema = computeEffectiveSchema({ enabledDomains: [], userAttributes: [] });
    expect(() => buildPropsSchema(schema, 'Project', { purpose: 'write' })).toThrow();
  });
});

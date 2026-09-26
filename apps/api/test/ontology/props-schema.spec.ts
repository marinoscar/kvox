/**
 * Closed `props` validation (issue #350, docs/specs/ontology.md §17.1, §17.3).
 * One case per attribute kind, valid and invalid, plus list wrapping, null on
 * required vs optional, closed-ness, deprecated-on-write and the extract
 * purpose's narrower attribute set.
 */
import {
  type UserAttributeDef,
  buildPropsSchema,
  computeEffectiveSchema,
  validateProps,
} from '@app/shared/ontology';

let seq = 0;
function def(kind: UserAttributeDef['kind'], over: Partial<UserAttributeDef> = {}): UserAttributeDef {
  seq += 1;
  return {
    id: `def-${kind}-${seq}`,
    entityType: 'Person',
    key: `u_${kind.replace('_', '').slice(0, 8).padEnd(8, 'x')}${String(seq).padStart(2, '0')}`,
    label: kind,
    kind,
    options: null,
    extractable: false,
    extractionHint: null,
    sensitivity: null,
    sortOrder: seq,
    deprecatedAt: null,
    ...over,
  };
}

const defs = {
  text: def('text'),
  number: def('number'),
  date: def('date'),
  boolean: def('boolean'),
  select: def('select', { options: { choices: [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue' }] } }),
  multi: def('multi_select', { options: { choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] } }),
  url: def('url'),
  ref: def('entity_ref', { options: { targetTypes: ['Person'] } }),
  old: def('text', { deprecatedAt: '2026-01-01T00:00:00Z' }),
  hinted: def('text', { extractable: true, extractionHint: 'A hint the model reads' }),
};

const schema = computeEffectiveSchema({ enabledDomains: ['work'], userAttributes: Object.values(defs) });
const UUID = '3f1c2e9a-8b7d-4c6e-a5f4-0123456789ab';

function check(key: string, value: unknown) {
  return validateProps(schema, 'Person', { [key]: value });
}

/** Asserts an issue at `path` (or inside it, e.g. `key.0`), each message naming the type. */
function expectIssueAt(result: ReturnType<typeof validateProps>, path: string, typeKey = 'Person') {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    const paths = result.issues.map((i) => i.path);
    expect({ paths, hit: paths.some((p) => p === path || p.startsWith(`${path}.`)) }).toMatchObject({ hit: true });
    for (const issue of result.issues) expect(issue.message.startsWith(typeKey)).toBe(true);
  }
}

describe('validateProps (write)', () => {
  it.each([
    ['text', defs.text.key, '  hello  ', ['', '   ', 42, 'x'.repeat(2001)]],
    ['number', defs.number.key, 3.5, ['3', Number.POSITIVE_INFINITY, Number.NaN]],
    ['date', defs.date.key, '2026-03-01', ['2026-3-1', '2026-02-30', '01/03/2026']],
    ['boolean', defs.boolean.key, false, ['true', 0]],
    ['select', defs.select.key, 'red', ['green', ['red']]],
    ['multi_select', defs.multi.key, ['a', 'b'], ['a', ['a', 'a'], ['c']]],
    ['url', defs.url.key, 'https://example.com/x', ['ftp://example.com', 'example.com', `https://e.com/${'x'.repeat(2048)}`]],
    ['entity_ref', defs.ref.key, UUID, ['not-a-uuid', 12]],
  ])('%s: accepts a valid value and rejects each invalid one at its path', (_kind, key, valid, invalids) => {
    expect(check(key as string, valid).ok).toBe(true);
    for (const invalid of invalids as unknown[]) expectIssueAt(check(key as string, invalid), key as string);
  });

  it('trims text on the way through', () => {
    expect(check(defs.text.key, '  hello  ')).toEqual({ ok: true, value: { [defs.text.key]: 'hello' } });
  });

  it('rejects a select value outside the choices, naming the choices', () => {
    const r = check(defs.select.key, 'green');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0].message).toMatch(/must be one of: red, blue/);
  });

  it('rejects an undeclared key, naming it (props are closed)', () => {
    const r = validateProps(schema, 'Person', { title: 'CTO', nickname: 'JJ' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toEqual([{ path: 'nickname', message: expect.stringContaining('Person.nickname: undeclared attribute') }]);
    }
  });

  it('rejects a non-object', () => {
    expectIssueAt(validateProps(schema, 'Person', 'x'), '');
    expectIssueAt(validateProps(schema, 'Person', null), '');
  });

  it('accepts null on an optional attribute (clear this key) and an empty object', () => {
    expect(validateProps(schema, 'Person', { title: null })).toEqual({ ok: true, value: { title: null } });
    expect(validateProps(schema, 'Person', {}).ok).toBe(true);
  });

  it('rejects null and absence on a required attribute', () => {
    const nulled = validateProps(schema, 'HAS_ROLE', { title: null }, { relation: true });
    expect(nulled).toEqual({ ok: false, issues: [{ path: 'title', message: 'HAS_ROLE.title: is required and may not be null' }] });
    const absent = validateProps(schema, 'HAS_ROLE', {}, { relation: true });
    expect(absent).toEqual({ ok: false, issues: [{ path: 'title', message: 'HAS_ROLE.title: is required' }] });
    expect(validateProps(schema, 'HAS_ROLE', { title: 'Staff Engineer' }, { relation: true }).ok).toBe(true);
  });

  it('list: true wraps the kind in an array of at most 50', () => {
    expect(validateProps(schema, 'Meeting', { topics: ['budget', 'hiring'] }).ok).toBe(true);
    expectIssueAt(validateProps(schema, 'Meeting', { topics: 'budget' }), 'topics', 'Meeting');
    expectIssueAt(validateProps(schema, 'Meeting', { topics: ['budget', ''] }), 'topics.1', 'Meeting');
    const tooMany = Array.from({ length: 51 }, (_, i) => `t${i}`);
    expectIssueAt(validateProps(schema, 'Meeting', { topics: tooMany }), 'topics', 'Meeting');
    const tooManyChoices = Array.from({ length: 51 }, () => 'a');
    expectIssueAt(check(defs.multi.key, tooManyChoices), defs.multi.key);
  });

  it('accepts a deprecated attribute on write so existing values round-trip', () => {
    expect(check(defs.old.key, 'legacy value')).toEqual({ ok: true, value: { [defs.old.key]: 'legacy value' } });
  });

  it('reports an unknown type as a root issue rather than throwing', () => {
    expect(validateProps(schema, 'Spaceship', {})).toEqual({
      ok: false,
      issues: [{ path: '', message: expect.stringContaining("Unknown entity type 'Spaceship'") }],
    });
  });
});

describe('buildPropsSchema', () => {
  it("purpose 'extract' includes only extractable, non-deprecated attributes", () => {
    const extract = buildPropsSchema(schema, 'Person', { purpose: 'extract' });
    expect(extract.safeParse({ title: 'CTO', [defs.hinted.key]: 'x' }).success).toBe(true);
    // Non-extractable (text) and deprecated (old) keys are undeclared for extraction.
    expect(extract.safeParse({ [defs.text.key]: 'x' }).success).toBe(false);
    expect(extract.safeParse({ [defs.old.key]: 'x' }).success).toBe(false);
    // Meeting's attributes are all non-extractable.
    expect(buildPropsSchema(schema, 'Meeting', { purpose: 'extract' }).safeParse({ topics: ['a'] }).success).toBe(false);
  });

  it("purpose 'extract' reads null as not stated", () => {
    const extract = buildPropsSchema(schema, 'Project', { purpose: 'extract' });
    expect(extract.safeParse({ status: null, startDate: null, endDate: '2026-12-31' }).success).toBe(true);
  });

  it('throws for a type absent from the effective schema', () => {
    const coreOnly = computeEffectiveSchema({ enabledDomains: [], userAttributes: [] });
    expect(() => buildPropsSchema(coreOnly, 'Project', { purpose: 'write' })).toThrow(/Unknown entity type 'Project'/);
    expect(() => buildPropsSchema(coreOnly, 'HAS_ROLE', { purpose: 'write', relation: true })).toThrow(
      /Unknown relation type 'HAS_ROLE'/,
    );
  });
});

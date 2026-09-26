import { z } from 'zod';

import {
  assertStrictJsonSchema,
  MAX_NESTING_DEPTH,
  MAX_TOTAL_PROPERTIES,
  StrictSchemaError,
  zodToStrictJsonSchema,
} from './strict-json-schema';
import type { JsonSchema } from '../providers/ai-provider.interface';

// =============================================================================
// The strict JSON-schema subset (issue #358)
// =============================================================================
//
// Every rejection is asserted to (a) be a `StrictSchemaError` — a plain Error
// subclass, never a domain class, because it is a programming error — and
// (b) NAME THE PATH of the offending node, because "your schema is invalid"
// with no location is the message that makes a 40-property extraction schema
// take an afternoon to fix.
// =============================================================================

function rejection(schema: unknown): StrictSchemaError {
  try {
    assertStrictJsonSchema(schema as JsonSchema);
  } catch (err) {
    expect(err).toBeInstanceOf(StrictSchemaError);
    return err as StrictSchemaError;
  }
  throw new Error('expected assertStrictJsonSchema to throw');
}

/** An object schema in strict form, from a property map. */
function obj(properties: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
    ...extra,
  };
}

describe('assertStrictJsonSchema — accepts', () => {
  it('nested objects, arrays and both nullable spellings', () => {
    expect(() =>
      assertStrictJsonSchema(
        obj(
          {
            title: { type: 'string', description: 'A heading.' },
            score: { type: ['number', 'null'] },
            tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
            owner: {
              anyOf: [
                obj({ name: { type: 'string' }, age: { type: 'integer' } }),
                { type: 'null' },
              ],
            },
            rows: {
              type: 'array',
              items: obj({ ok: { type: 'boolean' } }),
            },
          },
          { description: 'root' },
        ),
      ),
    ).not.toThrow();
  });

  it('internal $defs/$ref, including a recursive definition', () => {
    expect(() =>
      assertStrictJsonSchema(
        obj(
          { tree: { $ref: '#/$defs/node' } },
          {
            $defs: {
              node: obj({
                label: { type: 'string' },
                children: { type: 'array', items: { $ref: '#/$defs/node' } },
              }),
            },
          },
        ),
      ),
    ).not.toThrow();
  });

  it('an object with no properties at all', () => {
    expect(() => assertStrictJsonSchema(obj({}))).not.toThrow();
  });
});

describe('assertStrictJsonSchema — rejects, naming the path', () => {
  it('a non-object root', () => {
    const err = rejection({ type: 'array', items: { type: 'string' } });
    expect(err.path).toBe('$');
    expect(err.message).toMatch(/root must be an object/);

    expect(rejection({ anyOf: [obj({}), { type: 'null' }] }).path).toBe('$');
  });

  it('a missing additionalProperties: false', () => {
    const err = rejection(
      obj({
        inner: {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a'],
        },
      }),
    );
    expect(err.path).toBe('$.properties.inner');
    expect(err.message).toMatch(/additionalProperties: false/);
  });

  it('additionalProperties: true (only `false` is strict)', () => {
    expect(
      rejection({ ...obj({ a: { type: 'string' } }), additionalProperties: true }).message,
    ).toMatch(/additionalProperties: false/);
  });

  it('a property not in required', () => {
    const err = rejection({
      ...obj({ a: { type: 'string' }, b: { type: 'string' } }),
      required: ['a'],
    });
    expect(err.path).toBe('$');
    expect(err.message).toMatch(/"b" are not in `required`/);
  });

  it('a required key that is not a property', () => {
    const err = rejection({
      ...obj({ a: { type: 'string' } }),
      required: ['a', 'ghost'],
    });
    expect(err.message).toMatch(/"ghost"/);
  });

  it('a forbidden keyword, e.g. `format`', () => {
    const err = rejection(
      obj({ list: { type: 'array', items: { type: 'string', format: 'date-time' } } }),
    );
    expect(err.path).toBe('$.properties.list.items');
    expect(err.message).toMatch(/keyword "format"/);
  });

  it.each(['pattern', 'minimum', 'const', 'oneOf', 'default', 'minItems'])(
    'the forbidden keyword %s',
    (keyword) => {
      expect(
        rejection(obj({ a: { type: 'string', [keyword]: 1 } })).message,
      ).toMatch(new RegExp(`keyword "${keyword}"`));
    },
  );

  it('an external $ref', () => {
    const err = rejection(obj({ a: { $ref: 'https://example.com/schema.json' } }));
    expect(err.path).toBe('$.properties.a');
    expect(err.message).toMatch(/internal/);
  });

  it('a root-recursive `#` $ref (only #/$defs/... is internal here)', () => {
    expect(rejection(obj({ a: { $ref: '#' } })).path).toBe('$.properties.a');
  });

  it('a $ref to an undeclared definition', () => {
    expect(rejection(obj({ a: { $ref: '#/$defs/missing' } })).message).toMatch(
      /does not declare/,
    );
  });

  it('$defs anywhere but the root', () => {
    expect(
      rejection(obj({ a: { ...obj({}), $defs: { x: obj({}) } } })).path,
    ).toBe('$.properties.a');
  });

  it('a violation inside a $defs entry', () => {
    const err = rejection(
      obj({ a: { $ref: '#/$defs/bad' } }, { $defs: { bad: { type: 'object', properties: {} } } }),
    );
    expect(err.path).toBe('$.$defs.bad');
  });

  it('an unconstrained subschema', () => {
    expect(rejection(obj({ a: {} })).path).toBe('$.properties.a');
  });

  it('an array with no items', () => {
    expect(rejection(obj({ a: { type: 'array' } })).message).toMatch(/items/);
  });

  it(`objects nested deeper than ${MAX_NESTING_DEPTH} levels`, () => {
    let schema: Record<string, unknown> = obj({ leaf: { type: 'string' } });
    // The root is level 1; wrapping MAX_NESTING_DEPTH more times makes
    // MAX_NESTING_DEPTH + 1 levels.
    for (let i = 0; i < MAX_NESTING_DEPTH; i++) schema = obj({ n: schema });

    const err = rejection(schema);
    expect(err.message).toMatch(/nested more than 10 levels/);
    expect(err.path).toMatch(/^\$(\.properties\.n){10}$/);

    // Exactly at the limit is fine.
    let atLimit: Record<string, unknown> = obj({ leaf: { type: 'string' } });
    for (let i = 0; i < MAX_NESTING_DEPTH - 1; i++) atLimit = obj({ n: atLimit });
    expect(() => assertStrictJsonSchema(atLimit)).not.toThrow();
  });

  it(`more than ${MAX_TOTAL_PROPERTIES} properties in total`, () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_TOTAL_PROPERTIES; i++) many[`p${i}`] = { type: 'string' };

    expect(rejection(obj(many)).message).toMatch(/more than 5000 object properties/);
  });
});

describe('zodToStrictJsonSchema', () => {
  it('converts a strict-friendly Zod schema and drops the $schema marker', () => {
    const schema = zodToStrictJsonSchema(
      z.object({
        a: z.string().nullable(),
        b: z.array(z.enum(['x', 'y'])),
      }),
    );

    expect(schema).not.toHaveProperty('$schema');
    expect(schema).toEqual({
      type: 'object',
      properties: {
        a: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        b: { type: 'array', items: { type: 'string', enum: ['x', 'y'] } },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    });
  });

  it('throws for the same schema written with .optional() — callers must write .nullable()', () => {
    expect(() =>
      zodToStrictJsonSchema(
        z.object({
          a: z.string().optional(),
          b: z.array(z.enum(['x', 'y'])),
        }),
      ),
    ).toThrow(StrictSchemaError);
  });

  it('throws for a keyword Zod emits that strict mode refuses (.int() bounds)', () => {
    expect(() => zodToStrictJsonSchema(z.object({ n: z.number().int() }))).toThrow(
      /keyword "(minimum|maximum)"/,
    );
  });

  it('throws for a non-object root', () => {
    expect(() => zodToStrictJsonSchema(z.array(z.string()))).toThrow(/root must be an object/);
  });
});

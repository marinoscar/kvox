import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildPropsJsonSchema,
  computeEffectiveSchema,
  extractableEntityTypes,
  extractableRelationTypes,
} from '@app/shared/ontology';

// =============================================================================
// json-schema.spec.ts (issue #350) — a recursive walker asserting the OpenAI
// strict-mode subset every `buildPropsJsonSchema` output must obey
// (docs/specs/ontology.md §17.1, and json-schema.ts's own header):
//   - every object has additionalProperties: false and required === every
//     property key;
//   - only these keywords ever appear: type, properties, required,
//     additionalProperties, items, enum, anyOf, description;
//   - nesting depth <= 5 from the props root.
//
// Cross-check with #358's assertStrictJsonSchema: that function does not exist
// on this branch yet (apps/api/src/ai/structured/ does not exist). Per the
// issue, whichever of #350/#358 merges second adds the call — so this file
// probes for the module at run time and, when present, also calls it on every
// schema this suite builds, without needing an edit once #358 lands.
// =============================================================================

const ALLOWED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'anyOf',
  'description',
]);

const MAX_DEPTH = 5;

/** Walks a JSON Schema node and asserts the strict-mode rules, failing with the offending path. */
function walk(node: unknown, path: string, depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new Error(`json-schema: node at '${path}' exceeds max nesting depth ${MAX_DEPTH}`);
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    return;
  }
  const obj = node as Record<string, unknown>;

  for (const keyword of Object.keys(obj)) {
    if (!ALLOWED_KEYWORDS.has(keyword)) {
      throw new Error(`json-schema: node at '${path}' uses forbidden keyword '${keyword}'`);
    }
  }

  if (obj.type === 'object' || 'properties' in obj) {
    if (obj.additionalProperties !== false) {
      throw new Error(`json-schema: object at '${path}' does not set additionalProperties: false`);
    }
    const properties = (obj.properties ?? {}) as Record<string, unknown>;
    const required = obj.required;
    if (!Array.isArray(required)) {
      throw new Error(`json-schema: object at '${path}' has no required array`);
    }
    const propKeys = Object.keys(properties).sort();
    const requiredKeys = [...required].sort();
    if (JSON.stringify(propKeys) !== JSON.stringify(requiredKeys)) {
      throw new Error(
        `json-schema: object at '${path}' required (${JSON.stringify(requiredKeys)}) !== Object.keys(properties) (${JSON.stringify(propKeys)})`,
      );
    }
    for (const [key, child] of Object.entries(properties)) {
      walk(child, `${path}.${key}`, depth + 1);
    }
  }

  if ('items' in obj) {
    walk(obj.items, `${path}.items`, depth + 1);
  }

  if ('anyOf' in obj) {
    const variants = obj.anyOf;
    if (!Array.isArray(variants)) {
      throw new Error(`json-schema: anyOf at '${path}' is not an array`);
    }
    variants.forEach((variant, i) => walk(variant, `${path}.anyOf[${i}]`, depth + 1));
  }
}

function loadAssertStrictJsonSchema(): ((schema: unknown) => void) | null {
  const modulePath = join(__dirname, '..', '..', 'src', 'ai', 'structured', 'strict-json-schema.ts');
  if (!existsSync(modulePath)) return null;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../../src/ai/structured/strict-json-schema');
  if (typeof mod.assertStrictJsonSchema !== 'function') return null;
  return mod.assertStrictJsonSchema as (schema: unknown) => void;
}

const assertStrictJsonSchema = loadAssertStrictJsonSchema();

describe('buildPropsJsonSchema: strict-mode rules', () => {
  const schema = computeEffectiveSchema({ enabledDomains: ['work'], userAttributes: [] });
  const entityTypes = extractableEntityTypes(schema);
  const relationTypes = extractableRelationTypes(schema);

  it('extractableEntityTypes / extractableRelationTypes return a non-empty list under core+work', () => {
    expect(entityTypes.length).toBeGreaterThan(0);
    expect(relationTypes.length).toBeGreaterThan(0);
  });

  describe.each(entityTypes.map((key) => [key]))('entity type %s', (key: string) => {
    it('obeys the strict JSON Schema rules', () => {
      const output = buildPropsJsonSchema(schema, key);
      expect(() => walk(output, key, 1)).not.toThrow();
    });

    it('root required equals Object.keys(properties)', () => {
      const output = buildPropsJsonSchema(schema, key) as { properties: Record<string, unknown>; required: string[] };
      expect([...output.required].sort()).toEqual(Object.keys(output.properties).sort());
    });

    if (assertStrictJsonSchema) {
      it('passes assertStrictJsonSchema (#358)', () => {
        const output = buildPropsJsonSchema(schema, key);
        expect(() => assertStrictJsonSchema(output)).not.toThrow();
      });
    }
  });

  describe.each(relationTypes.map((key) => [key]))('relation type %s', (key: string) => {
    it('obeys the strict JSON Schema rules for its props', () => {
      const output = buildPropsJsonSchema(schema, key, { relation: true });
      expect(() => walk(output, key, 1)).not.toThrow();
    });

    it('root required equals Object.keys(properties)', () => {
      const output = buildPropsJsonSchema(schema, key, { relation: true }) as {
        properties: Record<string, unknown>;
        required: string[];
      };
      expect([...output.required].sort()).toEqual(Object.keys(output.properties).sort());
    });

    if (assertStrictJsonSchema) {
      it('passes assertStrictJsonSchema (#358)', () => {
        const output = buildPropsJsonSchema(schema, key, { relation: true });
        expect(() => assertStrictJsonSchema(output)).not.toThrow();
      });
    }
  });

  it('never emits a forbidden keyword (format, pattern, minLength, minimum, const, $ref, default) anywhere', () => {
    const forbidden = ['format', 'pattern', 'minLength', 'minimum', 'const', '$ref', 'default'];
    for (const key of entityTypes) {
      const serialized = JSON.stringify(buildPropsJsonSchema(schema, key));
      for (const word of forbidden) {
        expect(serialized.includes(`"${word}"`)).toBe(false);
      }
    }
  });

  it('throws for a type unknown to this effective schema', () => {
    expect(() => buildPropsJsonSchema(schema, 'NotAType')).toThrow();
  });
});

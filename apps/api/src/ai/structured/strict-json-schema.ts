import { z } from 'zod';

import type { JsonSchema } from '../providers/ai-provider.interface';

// =============================================================================
// OpenAI's strict JSON-schema subset, checked locally (issue #358, epic #345)
// =============================================================================
//
// `response_format: { type: 'json_schema', json_schema: { strict: true } }`
// accepts only a SUBSET of JSON Schema, and a schema outside it is refused by
// the vendor with a 400 — after the request has been built, sent and (for a
// long prompt) metered. This file answers "would the vendor accept this?"
// BEFORE anything is sent, and names the JSON path of the first violation so
// the fix is obvious. A violation is a PROGRAMMING ERROR in the caller's schema,
// never user data, which is why it is a plain `Error` subclass and not one of
// the domain classes in `../ai-errors.ts`.
//
// THE RULES (identical to #350's list, and deliberately stricter than the
// vendor in two places so a schema that passes here is portable to a future
// provider implementing `generateStructured` another way):
//
//   1. The root is `type: 'object'`.
//   2. Every object has `additionalProperties: false`, and `required` equals
//      the set of `properties` keys — no more, no fewer.
//   3. Optional values are spelled NULLABLE (`type: [T, 'null']` or
//      `anyOf: [..., { type: 'null' }]`). Rule 2 makes an absent key
//      unrepresentable, so a Zod `.optional()` fails here ON PURPOSE: callers
//      write `.nullable()`.
//   4. Only these keywords: `type`, `properties`, `required`,
//      `additionalProperties`, `items`, `enum`, `anyOf`, `description`, and
//      `$defs`/`$ref`. Everything else — `format`, `pattern`, `minimum`,
//      `const`, `oneOf`, `default`, … — is refused, including the bounds Zod
//      emits for `.int()` (so use `z.number()`), and `const` from
//      `z.literal()` (so use a one-member `z.enum()`).
//   5. `$ref` is internal only, `#/$defs/<name>`, resolving to a definition
//      declared in the ROOT's `$defs` (the only place `$defs` is accepted, and
//      where `z.toJSONSchema` puts them).
//   6. At most {@link MAX_NESTING_DEPTH} levels of object nesting and at most
//      {@link MAX_TOTAL_PROPERTIES} object properties in total.
//
// ⚠ RULE 6'S NUMBERS ARE THE VENDOR'S, as documented on OpenAI's Structured
// Outputs "Supported schemas" page as of 2026-09 (10 levels of nesting, 5000
// object properties). Re-verify them against the vendor docs with the same care
// as `MODELS` in `../providers/openai.provider.ts` — a stale higher limit would
// let a schema through that the vendor then refuses.
// =============================================================================

/** OpenAI's documented nesting limit for strict schemas (as of 2026-09). */
export const MAX_NESTING_DEPTH = 10;

/** OpenAI's documented total-object-properties limit (as of 2026-09). */
export const MAX_TOTAL_PROPERTIES = 5000;

const ALLOWED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'anyOf',
  'description',
  '$defs',
  '$ref',
]);

const ALLOWED_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
]);

const INTERNAL_REF = /^#\/\$defs\/([^/]+)$/;

/**
 * A schema outside the strict subset. `path` names where, e.g.
 * `$.properties.items.items.properties.label`.
 *
 * A PLAIN `Error` SUBCLASS, deliberately not a domain error: it is thrown by a
 * pre-flight on a schema a developer wrote, and "retryable" is irrelevant — it
 * fails identically on every attempt and the fix is in code.
 */
export class StrictSchemaError extends Error {
  constructor(
    message: string,
    /** JSON path of the offending node. */
    public readonly path: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'StrictSchemaError';
    Object.setPrototypeOf(this, StrictSchemaError.prototype);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Walk state shared across one whole check. */
interface WalkState {
  defs: Record<string, unknown>;
  totalProperties: number;
}

/**
 * Throw a {@link StrictSchemaError} naming the first violation of the strict
 * subset, or return normally. See the file header for the rules.
 *
 * `path` is the label the root is reported under (default `$`).
 */
export function assertStrictJsonSchema(schema: JsonSchema, path = '$'): void {
  if (!isPlainObject(schema)) {
    throw new StrictSchemaError('the schema must be a JSON object', path);
  }

  if (schema.type !== 'object') {
    throw new StrictSchemaError(
      'the root must be an object schema (`type: "object"`)',
      path,
    );
  }

  let defs: Record<string, unknown> = {};
  if (schema.$defs !== undefined) {
    if (!isPlainObject(schema.$defs)) {
      throw new StrictSchemaError('`$defs` must be an object', `${path}.$defs`);
    }
    defs = schema.$defs;
  }

  const state: WalkState = { defs, totalProperties: 0 };

  walk(schema, path, 0, state, true);

  for (const [name, def] of Object.entries(defs)) {
    // A definition is checked on its own, at the depth of the root: `$ref`
    // targets are not followed during the walk (a recursive schema would never
    // terminate), so this is where their contents are validated. Its
    // properties count toward the total ONCE, however often it is referenced —
    // an under-count of a heavily reused definition is the known limit of a
    // check that cannot expand recursion.
    walk(def, `${path}.$defs.${name}`, 0, state, false);
  }
}

function walk(
  node: unknown,
  path: string,
  objectDepth: number,
  state: WalkState,
  isRoot: boolean,
): void {
  if (!isPlainObject(node)) {
    throw new StrictSchemaError('every subschema must be a JSON object', path);
  }

  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      throw new StrictSchemaError(
        `keyword "${key}" is not permitted in a strict schema (allowed: ${[...ALLOWED_KEYWORDS].join(', ')})`,
        path,
      );
    }
  }

  if (node.$defs !== undefined && !isRoot) {
    throw new StrictSchemaError(
      '`$defs` is only permitted at the root, where every `$ref` resolves',
      path,
    );
  }

  if (node.description !== undefined && typeof node.description !== 'string') {
    throw new StrictSchemaError('`description` must be a string', path);
  }

  if (node.$ref !== undefined) {
    const ref = node.$ref;
    const match = typeof ref === 'string' ? INTERNAL_REF.exec(ref) : null;
    if (!match) {
      throw new StrictSchemaError(
        `\`$ref\` must be an internal "#/$defs/<name>" reference, got ${JSON.stringify(ref)}`,
        path,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(state.defs, match[1])) {
      throw new StrictSchemaError(
        `\`$ref\` "${String(ref)}" names a definition the root's \`$defs\` does not declare`,
        path,
      );
    }
    // A reference carries no shape of its own; its target is checked from
    // `$defs`. Only `description` may sit beside it (already checked above).
    const siblings = Object.keys(node).filter(
      (key) => key !== '$ref' && key !== 'description',
    );
    if (siblings.length > 0) {
      throw new StrictSchemaError(
        `\`$ref\` may only be accompanied by \`description\`, found ${siblings.join(', ')}`,
        path,
      );
    }
    return;
  }

  if (node.anyOf !== undefined) {
    if (!Array.isArray(node.anyOf) || node.anyOf.length === 0) {
      throw new StrictSchemaError('`anyOf` must be a non-empty array', path);
    }
    node.anyOf.forEach((branch, index) =>
      walk(branch, `${path}.anyOf[${index}]`, objectDepth, state, false),
    );
  }

  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) {
      throw new StrictSchemaError('`enum` must be a non-empty array', path);
    }
    for (const value of node.enum) {
      if (
        value !== null &&
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
      ) {
        throw new StrictSchemaError(
          '`enum` members must be strings, numbers, booleans or null',
          path,
        );
      }
    }
  }

  const types = readTypes(node, path);

  if (types === null && node.anyOf === undefined && node.enum === undefined) {
    throw new StrictSchemaError(
      'every subschema must declare `type`, `anyOf`, `enum` or `$ref` — an unconstrained schema cannot be decoded strictly',
      path,
    );
  }

  const isObject = types?.includes('object') ?? false;
  const isArray = types?.includes('array') ?? false;

  if (
    !isObject &&
    (node.properties !== undefined ||
      node.required !== undefined ||
      node.additionalProperties !== undefined)
  ) {
    throw new StrictSchemaError(
      '`properties`/`required`/`additionalProperties` are only meaningful on `type: "object"`',
      path,
    );
  }

  if (!isArray && node.items !== undefined) {
    throw new StrictSchemaError(
      '`items` is only meaningful on `type: "array"`',
      path,
    );
  }

  if (isObject) {
    checkObject(node, path, objectDepth + 1, state);
  }

  if (isArray) {
    if (node.items === undefined) {
      throw new StrictSchemaError(
        'an array schema must declare `items`',
        path,
      );
    }
    walk(node.items, `${path}.items`, objectDepth, state, false);
  }
}

function readTypes(node: Record<string, unknown>, path: string): string[] | null {
  if (node.type === undefined) return null;

  const raw = Array.isArray(node.type) ? node.type : [node.type];
  if (raw.length === 0) {
    throw new StrictSchemaError('`type` must not be an empty array', path);
  }

  for (const type of raw) {
    if (typeof type !== 'string' || !ALLOWED_TYPES.has(type)) {
      throw new StrictSchemaError(
        `\`type\` ${JSON.stringify(type)} is not a JSON Schema type`,
        path,
      );
    }
  }

  return raw as string[];
}

function checkObject(
  node: Record<string, unknown>,
  path: string,
  depth: number,
  state: WalkState,
): void {
  if (depth > MAX_NESTING_DEPTH) {
    throw new StrictSchemaError(
      `objects are nested more than ${MAX_NESTING_DEPTH} levels deep, the vendor's limit`,
      path,
    );
  }

  if (node.additionalProperties !== false) {
    throw new StrictSchemaError(
      'every object must declare `additionalProperties: false`',
      path,
    );
  }

  if (!isPlainObject(node.properties)) {
    throw new StrictSchemaError(
      'every object must declare `properties` as an object',
      path,
    );
  }

  const keys = Object.keys(node.properties);

  if (!Array.isArray(node.required)) {
    throw new StrictSchemaError(
      `every object must declare \`required\` listing all of its properties${keys.length > 0 ? ` (${keys.join(', ')})` : ''}`,
      path,
    );
  }

  const required = node.required as unknown[];
  for (const entry of required) {
    if (typeof entry !== 'string') {
      throw new StrictSchemaError('`required` must contain only strings', path);
    }
  }

  const requiredSet = new Set(required as string[]);
  const notRequired = keys.filter((key) => !requiredSet.has(key));
  if (notRequired.length > 0) {
    throw new StrictSchemaError(
      `properties ${notRequired.map((k) => `"${k}"`).join(', ')} are not in \`required\`; a strict schema requires every property — spell an optional value as nullable instead`,
      path,
    );
  }

  const keySet = new Set(keys);
  const unknownRequired = [...requiredSet].filter((key) => !keySet.has(key));
  if (unknownRequired.length > 0 || requiredSet.size !== required.length) {
    throw new StrictSchemaError(
      `\`required\` must equal the set of \`properties\` keys; it names ${unknownRequired.length > 0 ? unknownRequired.map((k) => `"${k}"`).join(', ') + ' which are not properties' : 'a key twice'}`,
      path,
    );
  }

  state.totalProperties += keys.length;
  if (state.totalProperties > MAX_TOTAL_PROPERTIES) {
    throw new StrictSchemaError(
      `the schema declares more than ${MAX_TOTAL_PROPERTIES} object properties in total, the vendor's limit`,
      path,
    );
  }

  for (const key of keys) {
    walk(
      node.properties[key],
      `${path}.properties.${key}`,
      depth,
      state,
      false,
    );
  }
}

/**
 * Convert a Zod schema to a strict-subset JSON Schema, or throw.
 *
 * `z.toJSONSchema` (draft 2020-12) minus the top-level `$schema` marker, which
 * the vendor does not want and rule 4 would refuse, then
 * {@link assertStrictJsonSchema}. A schema using `.optional()`, `.int()`,
 * `z.literal()` or a string format throws here — see the file header for the
 * strict-friendly spelling of each.
 */
export function zodToStrictJsonSchema(schema: z.ZodType): JsonSchema {
  const converted = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
  }) as JsonSchema;

  const { $schema: _ignored, ...rest } = converted;

  assertStrictJsonSchema(rest);

  return rest;
}

// =============================================================================
// Settings schema introspection helpers (issue #459, ported from EnterpriseAppBase)
// =============================================================================
//
// Framework-free, zod-only. Used by the namespace registries' `validate` hooks
// at import time, so a namespace that would leak a secret into
// `GET /api/system-settings` (or materialise a value through `.default()`)
// fails the moment the manifest registers it, not in a security review.
// =============================================================================

import { z } from 'zod';

/** The definition of any zod v4 schema, as far as this walk needs it. */
interface WalkedDef {
  type?: string;
  shape?: Record<string, unknown>;
  innerType?: unknown;
  in?: unknown;
  out?: unknown;
  element?: unknown;
  valueType?: unknown;
  options?: unknown[];
  left?: unknown;
  right?: unknown;
  items?: unknown[];
  rest?: unknown;
}

function defOf(schema: unknown): WalkedDef | undefined {
  const internals = (schema as { _zod?: { def?: WalkedDef } } | undefined)?._zod;
  return internals?.def;
}

/**
 * Visit every schema reachable from `schema` (object fields, array elements,
 * record values, union options, wrapper inner types, both sides of a pipe),
 * calling `visit(def, path)` for each. Bounded in depth so a self-referencing
 * schema cannot hang the import.
 *
 * @stability experimental
 */
export function walkSchema(
  schema: unknown,
  visit: (def: WalkedDef, path: string) => void,
  path = '',
  depth = 0,
): void {
  if (depth > 32) return;
  const def = defOf(schema);
  if (!def) return;
  visit(def, path);

  const next = (child: unknown, childPath: string) => walkSchema(child, visit, childPath, depth + 1);

  switch (def.type) {
    case 'object':
      for (const [key, field] of Object.entries(def.shape ?? {})) {
        next(field, path ? `${path}.${key}` : key);
      }
      break;
    case 'array':
      next(def.element, `${path}[]`);
      break;
    case 'record':
      next(def.valueType, `${path}.*`);
      break;
    case 'union':
      for (const option of def.options ?? []) next(option, path);
      break;
    case 'intersection':
      next(def.left, path);
      next(def.right, path);
      break;
    case 'tuple':
      for (const item of def.items ?? []) next(item, `${path}[]`);
      if (def.rest) next(def.rest, `${path}[]`);
      break;
    case 'pipe':
      next(def.in, path);
      next(def.out, path);
      break;
    default:
      if (def.innerType !== undefined) next(def.innerType, path);
  }
}

/**
 * Every object property path in `schema` whose last segment names a secret
 * (compared case-insensitively against `names`). Empty when there is none.
 *
 * @stability experimental
 */
export function findSecretFieldPaths(schema: unknown, names: readonly string[]): string[] {
  const forbidden = new Set(names.map((name) => name.toLowerCase()));
  const found: string[] = [];

  walkSchema(schema, (def, path) => {
    if (def.type !== 'object') return;
    for (const key of Object.keys(def.shape ?? {})) {
      if (forbidden.has(key.toLowerCase())) found.push(path ? `${path}.${key}` : key);
    }
  });

  return found;
}

/**
 * Every path in `schema` that carries a `.default()` or `.prefault()`.
 *
 * @stability experimental
 */
export function findDefaultPaths(schema: unknown): string[] {
  const found: string[] = [];
  walkSchema(schema, (def, path) => {
    if (def.type === 'default' || def.type === 'prefault') found.push(path || '(root)');
  });
  return found;
}

/**
 * Whether `value` is a zod schema.
 *
 * @stability experimental
 */
export function isZodSchema(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

// =============================================================================
// User settings namespace registry (issue #459, mirrors EnterpriseAppBase
// `settings/registry/user-settings-namespace.ts`)
// =============================================================================
//
// The OPTIONAL namespaces of `user_settings.value` (`dataTables`, `navigation`,
// `notifications`, `onboarding`, `graph`), each declared once beside the module
// that owns it as one `UserSettingsNamespace`. `theme` and `profile` are core
// fields, not namespaces: the composers place them ahead of every namespace
// (`core-user-fields.ts`).
//
// ABSENT IS INFORMATION. A user namespace is always `.optional()` in the stored
// shape and never `.default()` anywhere (registration refuses one): an absent
// namespace means "use the built-in defaults", and materialising it would
// freeze a user at today's defaults (see the header of
// `common/schemas/user-settings-namespaces.schema.ts`).
//
// Framework-free: zod and the registry primitive only.
// =============================================================================

import type { z } from 'zod';

import { defineRegistry } from '../../common/registry/define-registry';
import { SETTINGS_SECRET_FIELD_NAMES, secretFieldMessage } from './secret-fields';
import { findDefaultPaths, findSecretFieldPaths, isZodSchema } from './schema-walk';
import { SETTINGS_NAMESPACE_KEY_PATTERN } from './system-settings-namespace';

/**
 * One optional namespace of a user's settings document.
 *
 * @typeParam K - the top-level key, e.g. `'dataTables'`.
 * @typeParam V - the stored value type.
 * @typeParam P - the parsed PATCH body branch `merge` receives (without `null`).
 */
export interface UserSettingsNamespace<K extends string = string, V = unknown, P = unknown> {
  /** Top-level key in `user_settings.value`. Matches `/^[a-z][A-Za-z0-9]*$/`. */
  readonly key: K;
  /** One sentence on what the namespace holds (docs and error messages). */
  readonly description: string;
  /** The stored shape; composed with `.optional()`, never `.default()`. Bounded. */
  readonly schema: z.ZodType<V>;
  /** The canonical partial; composed with `.nullable().optional()` (`null` clears the namespace). */
  readonly patchSchema: z.ZodType;
  /** The PUT request-body branch. Default: `schema`. */
  readonly putSchema?: z.ZodType;
  /** The PATCH request-body branch. Default: `patchSchema`. */
  readonly wirePatchSchema?: z.ZodType;
  /**
   * The branch of the documented response. Default: `schema`; `null` for a
   * namespace the documented response does not declare (it is still returned).
   */
  readonly responseSchema?: z.ZodType | null;
  /**
   * JSON Merge Patch for the namespace: `patch` is `undefined` (body does not
   * mention it: keep `current`), `null` (clear it) or the parsed branch.
   * Return `undefined` for "absent": an emptied namespace is never stored as `{}`.
   */
  merge(current: V | undefined, patch: P | null | undefined): V | undefined;
  /**
   * Throw an HTTP 400 (`BadRequestException`) when the MERGED value exceeds a
   * cap zod cannot express (a key count on a `z.record`). Runs after the merge,
   * before validation, on PUT and PATCH alike.
   */
  assertLimits?(value: V | undefined): void;
  /**
   * Field names this namespace refuses on top of the global deny-list
   * (`SETTINGS_SECRET_FIELD_NAMES`), checked the same way.
   */
  readonly forbiddenKeys?: readonly string[];
}

/**
 * Top-level keys the stored value or the response reserve for core fields.
 */
export const RESERVED_USER_SETTINGS_KEYS = ['theme', 'profile', 'updatedAt', 'version'] as const;

function validateUserNamespace(ns: UserSettingsNamespace): void {
  if (typeof ns.description !== 'string' || ns.description.trim() === '') {
    throw new Error('description is required');
  }
  for (const field of ['schema', 'patchSchema'] as const) {
    if (!isZodSchema(ns[field])) throw new Error(`${field} must be a zod schema`);
  }
  for (const field of ['putSchema', 'wirePatchSchema'] as const) {
    if (ns[field] !== undefined && !isZodSchema(ns[field])) throw new Error(`${field} must be a zod schema when set`);
  }
  if (ns.responseSchema !== undefined && ns.responseSchema !== null && !isZodSchema(ns.responseSchema)) {
    throw new Error('responseSchema must be a zod schema, null, or left out');
  }
  if (typeof ns.merge !== 'function') throw new Error('merge is required');
  if (ns.assertLimits !== undefined && typeof ns.assertLimits !== 'function') {
    throw new Error('assertLimits must be a function');
  }
  if ((RESERVED_USER_SETTINGS_KEYS as readonly string[]).includes(ns.key)) {
    throw new Error(`"${ns.key}" is a core field of user settings, not a namespace`);
  }

  if (ns.forbiddenKeys !== undefined && (!Array.isArray(ns.forbiddenKeys) || ns.forbiddenKeys.some((k) => typeof k !== 'string'))) {
    throw new Error('forbiddenKeys must be an array of field names');
  }
  const denied = [...SETTINGS_SECRET_FIELD_NAMES, ...(ns.forbiddenKeys ?? [])];
  for (const field of ['schema', 'patchSchema', 'putSchema', 'wirePatchSchema', 'responseSchema'] as const) {
    const defaults = findDefaultPaths(ns[field]);
    if (defaults.length > 0) {
      throw new Error(
        `${field} carries .default() at ${defaults.join(', ')}; a user namespace must stay absent until the user chooses (see user-settings-namespaces.schema.ts)`,
      );
    }
    const secrets = findSecretFieldPaths(ns[field], denied);
    if (secrets.length > 0) throw new Error(secretFieldMessage(field, secrets, 'user'));
  }
}

/**
 * The optional user settings namespaces, in registration order: the order of
 * every composed user-settings schema and of the OpenAPI document. Filled by
 * the app at import time (`kvox.manifest.ts`).
 */
export const userSettingsNamespaceRegistry = defineRegistry<UserSettingsNamespace>({
  name: 'user-settings-namespaces',
  idOf: (ns) => ns.key,
  idPattern: SETTINGS_NAMESPACE_KEY_PATTERN,
  validate: (ns) => validateUserNamespace(ns),
  describeDuplicate: (_existing, incoming) =>
    `User settings namespace "${incoming.key}" is already registered. Each namespace is declared once, beside the module that owns it.`,
});

// Same trap as the system registry's: a namespace registered after the PUT and
// PATCH bodies were composed would be stripped from every write.
let requestBodiesComposed = false;

/**
 * Registers user namespaces, all or nothing. Registration order is the
 * composed schemas' key order and the OpenAPI document's: append, never insert.
 *
 * @throws Error when the request bodies were already composed.
 * @throws RegistryError naming the entry when one is invalid (a duplicate or
 *   reserved key, a `.default()`, a secret-named field).
 */
export function registerUserSettingsNamespaces(namespaces: readonly UserSettingsNamespace[]): void {
  if (requestBodiesComposed) {
    const keys = namespaces.map((ns) => `"${ns.key}"`).join(', ');
    throw new Error(
      `Cannot register user settings namespace(s) ${keys}: the PUT and PATCH request bodies were already composed ` +
        'without them, so every write of them would be silently dropped. ' +
        'Register namespaces in apps/api/src/kvox.manifest.ts, which every entry point imports first.',
    );
  }
  userSettingsNamespaceRegistry.registerAll(namespaces);
}

/**
 * Records that the user-settings request-body DTOs were composed from the
 * registry as it is now.
 */
export function markUserSettingsRequestBodiesComposed(): void {
  requestBodiesComposed = true;
}

/** Whether {@link markUserSettingsRequestBodiesComposed} has been called. */
export function areUserSettingsRequestBodiesComposed(): boolean {
  return requestBodiesComposed;
}

// =============================================================================
// System settings namespace registry (issue #459, mirrors EnterpriseAppBase
// `settings/registry/system-settings-namespace.ts`, minus the org layer)
// =============================================================================
//
// Every top-level key of `system_settings.value` (the 'global' row) is a
// NAMESPACE, declared once, beside the module that owns it, as one
// `SystemSettingsNamespace`. The declaration bundles everything the six places
// of `common/schemas/settings-parity.spec.ts` used to restate by hand: the
// stored shape, the canonical partial, the PUT and PATCH request-body branches,
// the response branch and the defaults. The composed schemas and
// `composeDefaultSystemSettings()` are DERIVED from this registry
// (`compose.ts`).
//
// Field names match the platform's so Epic 1 issue 1.4 can swap the import.
// This app is single-org, so the platform's `org` layer, `read` and `merge` hooks
// are omitted; the service's hand-written merge stays where it is.
//
// ORDER IS WIRE-VISIBLE. Registration order is the stored JSON's key order and
// the OpenAPI document's property order: append, never insert.
//
// Framework-free: zod and the registry primitive only.
// =============================================================================

import { z } from 'zod';

import { defineRegistry } from '../../common/registry/define-registry';
import { SETTINGS_SECRET_FIELD_NAMES, secretFieldMessage } from './secret-fields';
import { findSecretFieldPaths, isZodSchema } from './schema-walk';

/**
 * One namespace of the system settings document.
 *
 * @typeParam K - the top-level key, e.g. `'jobs'`.
 * @typeParam V - the stored value type (what `SystemSettingsNamespaces[K]` is).
 * @typeParam _P - the parsed PATCH body branch; carried for parity with the platform, unused here.
 */
export interface SystemSettingsNamespace<K extends string = string, V = unknown, _P = unknown> {
  /** Top-level key in `system_settings.value`. Matches `/^[a-z][A-Za-z0-9]*$/`. */
  readonly key: K;
  /** One sentence on what the namespace configures (docs and error messages). */
  readonly description: string;
  /**
   * The value as STORED (place 1, `systemSettingsSchema`). Always complete:
   * `readKnownSettings` fills it from `defaults`. Never `.default()`.
   */
  readonly storedSchema: z.ZodType<V>;
  /** The canonical partial (place 2, `systemSettingsPatchSchema`); composed with `.optional()`. */
  readonly patchSchema: z.ZodType;
  /** The PUT request-body branch (place 3, `updateSystemSettingsSchema`). */
  readonly putSchema: z.ZodType;
  /** The PATCH request-body branch (place 4, `patchSystemSettingsSchema`); composed with `.optional()`. */
  readonly wirePatchSchema: z.ZodType;
  /**
   * The branch of `systemSettingsResponseSchema` (the OpenAPI response
   * contract), or `null` for a namespace the documented response does not
   * declare. `null` is a decision, never an omission: the field must be present.
   */
  readonly responseSchema: z.ZodType | null;
  /** The defaults (place 5), the only place they live. Must satisfy `storedSchema`. */
  readonly defaults: V;
  /**
   * Whether a PUT body must carry the namespace. `false` means a PUT that omits
   * it keeps the stored value (`replaceSettings` carries it forward).
   */
  readonly requiredOnPut: boolean;
  /**
   * Field names this namespace refuses on top of the global deny-list
   * (`SETTINGS_SECRET_FIELD_NAMES`), checked the same way: any depth, any case.
   */
  readonly forbiddenKeys?: readonly string[];
}

/**
 * Top-level keys the response or the row reserve for core fields.
 */
export const RESERVED_SYSTEM_SETTINGS_KEYS = ['security', 'updatedAt', 'updatedBy', 'version'] as const;

/**
 * The pattern every namespace key must match: a lower-case letter, then letters and digits.
 */
export const SETTINGS_NAMESPACE_KEY_PATTERN = /^[a-z][A-Za-z0-9]*$/;

function validateSystemNamespace(ns: SystemSettingsNamespace): void {
  if (typeof ns.description !== 'string' || ns.description.trim() === '') {
    throw new Error('description is required');
  }
  for (const field of ['storedSchema', 'patchSchema', 'putSchema', 'wirePatchSchema'] as const) {
    if (!isZodSchema(ns[field])) throw new Error(`${field} must be a zod schema`);
  }
  if (ns.responseSchema !== null && !isZodSchema(ns.responseSchema)) {
    throw new Error('responseSchema must be a zod schema, or null for a namespace the response does not document');
  }
  if (ns.defaults === undefined) throw new Error('defaults is required');
  if (typeof ns.requiredOnPut !== 'boolean') throw new Error('requiredOnPut must be a boolean');
  if ((RESERVED_SYSTEM_SETTINGS_KEYS as readonly string[]).includes(ns.key)) {
    throw new Error(`"${ns.key}" is a core field of the system settings response, not a namespace`);
  }

  // The generic form of the per-namespace compile-time proofs: this document is
  // returned wholesale by GET /api/system-settings and copied into every
  // settings audit row. Secrets belong in the credential store.
  if (ns.forbiddenKeys !== undefined && (!Array.isArray(ns.forbiddenKeys) || ns.forbiddenKeys.some((k) => typeof k !== 'string'))) {
    throw new Error('forbiddenKeys must be an array of field names');
  }
  const denied = [...SETTINGS_SECRET_FIELD_NAMES, ...(ns.forbiddenKeys ?? [])];
  for (const field of ['storedSchema', 'putSchema', 'wirePatchSchema', 'responseSchema'] as const) {
    const secrets = findSecretFieldPaths(ns[field], denied);
    if (secrets.length > 0) throw new Error(secretFieldMessage(field, secrets, 'system'));
  }

  const parsed = ns.storedSchema.safeParse(ns.defaults);
  if (!parsed.success) {
    throw new Error(`defaults do not satisfy storedSchema: ${parsed.error.message}`);
  }
}

// Set once the request-body DTOs have been composed from the registry: a
// namespace registered later would be stored and returned, but every PUT and
// PATCH of it would be stripped by the validation pipe before the service saw
// it (the silent no-op the parity spec header describes).
let requestBodiesComposed = false;

/**
 * The system settings namespaces, in registration order: the order of the
 * stored JSON's keys, of every composed schema and of the OpenAPI document.
 * Filled by the app at import time (`kvox.manifest.ts`), before the request
 * bodies are composed from it.
 */
export const systemSettingsNamespaceRegistry = defineRegistry<SystemSettingsNamespace>({
  name: 'system-settings-namespaces',
  idOf: (ns) => ns.key,
  idPattern: SETTINGS_NAMESPACE_KEY_PATTERN,
  validate: (ns) => validateSystemNamespace(ns),
  describeDuplicate: (_existing, incoming) =>
    `System settings namespace "${incoming.key}" is already registered. Each namespace is declared once, beside the module that owns it.`,
});

/**
 * Registers system namespaces, all or nothing (see the registry primitive's
 * rules). Registration order is the stored JSON's key order and the OpenAPI
 * document's: append, never insert.
 *
 * @throws Error when the request bodies were already composed (the namespace
 *   would be silently stripped from every PUT and PATCH).
 * @throws RegistryError naming the entry when one is invalid: a duplicate or
 *   malformed key, a missing part, defaults that fail `storedSchema`, or a
 *   secret-named field.
 */
export function registerSystemSettingsNamespaces(namespaces: readonly SystemSettingsNamespace[]): void {
  if (requestBodiesComposed) {
    const keys = namespaces.map((ns) => `"${ns.key}"`).join(', ');
    throw new Error(
      `Cannot register system settings namespace(s) ${keys}: the PUT and PATCH request bodies were already composed ` +
        'without them, so every write of them would be silently dropped. ' +
        'Register namespaces in apps/api/src/kvox.manifest.ts, which every entry point imports first.',
    );
  }
  systemSettingsNamespaceRegistry.registerAll(namespaces);
}

/**
 * Records that the request-body DTOs were composed from the registry as it is
 * now. Called where a `createZodDto` class is built from the composers.
 */
export function markSystemSettingsRequestBodiesComposed(): void {
  requestBodiesComposed = true;
}

/** Whether {@link markSystemSettingsRequestBodiesComposed} has been called. */
export function areSystemSettingsRequestBodiesComposed(): boolean {
  return requestBodiesComposed;
}

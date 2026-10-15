import { z } from 'zod';
import {
  systemSettingsSchema,
  systemSettingsPatchSchema,
} from './settings.schema';
import {
  updateSystemSettingsSchema,
  patchSystemSettingsSchema,
} from '../../settings/dto/update-system-settings.dto';
import { systemSettingsResponseSchema } from '../../settings/dto/system-settings-response.dto';
import { DEFAULT_SYSTEM_SETTINGS } from '../types/settings.types';
import {
  composeDefaultSystemSettings,
  systemSettingsNamespaceRegistry,
  type SystemSettingsNamespace,
} from '../../settings/registry';

// =============================================================================
// System settings parity guard (#256, epic #254; rewritten over the registry, #459)
// =============================================================================
//
// WHAT A FAILURE HERE MEANS. A registered namespace, or a field inside one, is
// missing from (or extra in) one of the places that define `system_settings`.
// The failure message names the key and the two sources that disagree; the fix
// is always to repair the declaration or the composition, never to loosen this
// test.
//
// WHAT CHANGED IN #459. Until then the places below were written out by hand,
// one after the other, and this file's job was to notice a namespace added to
// some of them and not the others. A namespace is now DECLARED ONCE
// (`SystemSettingsNamespace`, beside the module that owns it, registered from
// `kvox.manifest.ts`) and each place is DERIVED from the registry by a composer
// (`settings/registry/compose.ts`). The "added it to four of five" mistake can
// no longer be made, so this file iterates the REGISTRY instead of one schema:
// for every registered namespace it asserts that the composed schemas, the DTO
// bodies and the defaults the app actually uses all carry its key, and that the
// declaration's own branches agree about its fields (a `patchSchema` that
// forgot a field the `storedSchema` has is the same silent failure, one level
// down). Iterating the registry is also what keeps the guard honest for a
// namespace a fork registers: it is checked without touching this file.
//
// THE PLACES, AND WHAT EACH ONE BREAKS WHEN IT IS THE ONE THAT DOES NOT CARRY
// A NAMESPACE (each is the composed form of one field of the declaration):
//
//   1. `systemSettingsSchema`          from `storedSchema`
//        The canonical stored shape. Missing here → the service's own
//        `parse` strips the key on the way to the database, so nothing is
//        ever persisted.
//   2. `systemSettingsPatchSchema`     from `patchSchema`
//        The canonical partial. Missing here → the merged value fails to
//        validate, or the namespace can never be partially updated.
//   3. `updateSystemSettingsSchema`    from `putSchema` (+ `requiredOnPut`)
//        The PUT REQUEST BODY. Missing here → the global ZodValidationPipe
//        strips the key BEFORE the service is called. A full replacement
//        silently drops the namespace.
//   4. `patchSystemSettingsSchema`     from `wirePatchSchema`
//        The PATCH REQUEST BODY, and the nastiest of the lot. Missing here →
//        `PATCH { "databaseBackup": { "enabled": true } }` parses to `{}`,
//        the service merges nothing, the row is rewritten unchanged and the
//        endpoint returns 200 with a body that looks correct. No error, no
//        log line, no audit entry: the classic silent no-op this file exists
//        to prevent. The registry also refuses to register a namespace after
//        the request bodies were composed, for the same reason.
//   5. `DEFAULT_SYSTEM_SETTINGS`       from `defaults`
//        The defaults, and the only place they live. Missing here → a
//        deployment that has never saved the key reads `undefined` where
//        `SystemSettingsValue` promises a value, and `readKnownSettings` has
//        nothing to degrade to.
//   +  `systemSettingsResponseSchema`  from `responseSchema` (`null` opts out)
//        The documented response. It was not one of the original places (the
//        wire response is shaped by the service), so a namespace is allowed to
//        decide it is undocumented, but the decision has to be explicit.
//
// The merge in `settings/system-settings/system-settings.service.ts` is
// deliberately NOT checked here. It cannot be: a merge is behaviour, not a key
// set, and a merge that reads the right key and applies it wrongly has exactly
// the same shape as one that is correct. That one is covered where behaviour is
// covered, by `system-settings.service.spec.ts` and by
// `test/settings/system-settings.integration.spec.ts` (which drives a real
// PATCH through the wire DTO and asserts what reached Prisma).
//
// HOW THE KEY SETS ARE OBTAINED. Programmatically, from the registry and from
// the zod schemas themselves - never from a list written out in this file. A
// hand-maintained list is the same defect one level up: it would need updating
// in one more place, and the day someone forgot it this test would go green
// while the endpoint was broken. The registry is filled by `test/setup.ts`
// importing `kvox.manifest`; the first case below fails loudly if it is not.
// =============================================================================

/**
 * Strip the wrappers that carry no keys of their own.
 *
 * `.optional()`, `.nullable()`, `.default()` and friends are all a box around
 * the schema that actually has a `.shape`, and every one of them appears in at
 * least one of the sources: the PATCH schemas wrap every namespace in
 * `.optional()`, the PUT body wraps the operations namespaces in it, and the
 * canonical schema wraps none of them. Comparing key sets without unwrapping
 * would therefore compare "optional" against "required" and report a
 * difference that is not one — while hiding the differences that are.
 */
function unwrap(schema: unknown): unknown {
  let current = schema;

  // Bounded rather than `while (true)`: a schema wrapped in itself would
  // otherwise hang the suite instead of failing it.
  for (let depth = 0; depth < 16; depth += 1) {
    const def = (current as { _def?: { type?: string; innerType?: unknown; in?: unknown } })
      ?._def;

    switch (def?.type) {
      case 'optional':
      case 'nullable':
      case 'nonoptional':
      case 'default':
      case 'prefault':
      case 'catch':
      case 'readonly':
        current = def.innerType;
        break;
      // `z.ZodPipe` is what zod v4 produces for `.transform()` and friends —
      // the v3 `ZodEffects` this repo no longer has. The INPUT side is the one
      // that describes what a caller may send, which is what parity is about.
      case 'pipe':
        current = def.in;
        break;
      default:
        return current;
    }
  }

  return current;
}

/**
 * The property names of an object schema, or `null` for anything that has no
 * fixed set of them.
 *
 * `null` rather than `[]` on purpose. A namespace shaped like an open
 * `z.record` (an operator-supplied map with no fixed key set, the way the
 * removed `features` namespace was before #366) has no field set to compare;
 * returning `[]` for one would make it look like an object with no properties
 * and put it in permanent, spurious disagreement with its own default value.
 * `null` means "not comparable", and comparison is skipped.
 */
function objectKeys(schema: unknown): string[] | null {
  const unwrapped = unwrap(schema);
  if (!(unwrapped instanceof z.ZodObject)) {
    return null;
  }

  return Object.keys(unwrapped.shape as Record<string, unknown>);
}

/** The same question, asked of a plain value rather than a schema. */
function valueKeys(value: unknown): string[] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return Object.keys(value as Record<string, unknown>);
}

/**
 * A place that carries namespaces, reduced to "top-level keys" plus "the keys
 * one level inside each of them".
 *
 * ONE LEVEL, not arbitrary depth. That is the depth at which the places
 * actually restate each other — the wire DTOs and the defaults work
 * namespace-by-field — and it is the depth at which a mistake is silent.
 * `jobs.history.retentionDays` sits one level deeper; getting it wrong there is
 * a type error at compile time, because `SystemSettingsValue` is derived from
 * the same schema.
 */
interface Source {
  readonly name: string;
  readonly top: string[];
  readonly children: (namespace: string) => string[] | null;
}

const schemaSource = (
  name: string,
  schema: z.ZodObject<z.ZodRawShape>,
): Source => {
  const shape = schema.shape as Record<string, unknown>;
  return {
    name,
    top: Object.keys(shape),
    children: (namespace) =>
      namespace in shape ? objectKeys(shape[namespace]) : null,
  };
};

/** The keys of `systemSettingsResponseSchema` that are the response's own, not a namespace's. */
const RESPONSE_ONLY_KEYS = ['security', 'updatedAt', 'updatedBy', 'version'];

const responseSource = (): Source => {
  const base = schemaSource(
    'systemSettingsResponseSchema (response body)',
    systemSettingsResponseSchema,
  );
  return {
    ...base,
    top: base.top.filter((key) => !RESPONSE_ONLY_KEYS.includes(key)),
  };
};

const defaultsSource = (name: string, defaults: unknown): Source => ({
  name,
  top: Object.keys(defaults as Record<string, unknown>),
  children: (namespace) =>
    valueKeys((defaults as Record<string, unknown>)[namespace]),
});

// The canonical stored shape is the reference the field-level comparison runs
// against, because it is the one a stored value has to satisfy.
const REFERENCE = schemaSource('systemSettingsSchema', systemSettingsSchema);

/** Every place that must carry EVERY registered namespace. */
const COMPLETE_SOURCES: Source[] = [
  REFERENCE,
  schemaSource('systemSettingsPatchSchema', systemSettingsPatchSchema),
  schemaSource('updateSystemSettingsSchema (PUT body)', updateSystemSettingsSchema),
  schemaSource('patchSystemSettingsSchema (PATCH body)', patchSystemSettingsSchema),
  defaultsSource('DEFAULT_SYSTEM_SETTINGS', DEFAULT_SYSTEM_SETTINGS),
  defaultsSource('composeDefaultSystemSettings()', composeDefaultSystemSettings()),
];

/** Every registered declaration, in registration order. Read when the cases run. */
const registered = (): readonly SystemSettingsNamespace[] =>
  systemSettingsNamespaceRegistry.list();

/**
 * Compare two key sets and report the difference by NAME.
 *
 * Deliberately not `expect(a.sort()).toEqual(b.sort())`: that reports two lists
 * and leaves the reader to diff them. This reports the answer — which keys are
 * missing, which are unexpected — which is the whole point of a guard whose
 * failure will usually be read by someone who has just added a namespace and
 * does not yet know which place they missed.
 */
function expectSameKeys(actual: string[], expected: string[], context: string) {
  const missing = expected.filter((key) => !actual.includes(key));
  const unexpected = actual.filter((key) => !expected.includes(key));

  expect({ context, missing, unexpected }).toEqual({
    context,
    missing: [],
    unexpected: [],
  });
}

describe('system settings parity across the places a namespace must be declared', () => {
  it('has the namespaces registered, which is what the composed schemas are built from', () => {
    // An empty registry would make every assertion below vacuous. It also means
    // `test/setup.ts` stopped importing `src/kvox.manifest`, and the composers
    // would already have thrown while the schemas above were being imported.
    expect(registered().length).toBeGreaterThan(0);
  });

  // AGGREGATED ACROSS SOURCES, not one `expect` per source in a loop. Missing a
  // namespace in several places at once is the NORMAL failure, and a loop of
  // assertions reports only whichever source it reached first, sending the
  // reader back for another run after each fix. One report names every place
  // that disagrees with the registry.
  it('carries exactly the registered namespaces, in registration order, in every place', () => {
    const ids = registered().map((ns) => ns.key);

    const disagreements = COMPLETE_SOURCES.map((source) => ({
      source: source.name,
      missing: ids.filter((key) => !source.top.includes(key)),
      unexpected: source.top.filter((key) => !ids.includes(key)),
    })).filter(
      (report) => report.missing.length > 0 || report.unexpected.length > 0,
    );

    expect({ comparedAgainst: 'systemSettingsNamespaceRegistry', disagreements }).toEqual({
      comparedAgainst: 'systemSettingsNamespaceRegistry',
      disagreements: [],
    });

    // Order is wire-visible (stored JSON, OpenAPI). `DEFAULT_SYSTEM_SETTINGS`
    // keeps its own historical key order and is compared as a set above.
    for (const source of COMPLETE_SOURCES.filter((s) => !s.name.includes('DEFAULT') && !s.name.includes('Defaults'))) {
      expect({ source: source.name, order: source.top }).toEqual({
        source: source.name,
        order: ids,
      });
    }
  });

  it('documents in the response exactly the namespaces whose declaration has a responseSchema', () => {
    const documented = registered()
      .filter((ns) => ns.responseSchema !== null)
      .map((ns) => ns.key);

    expectSameKeys(
      responseSource().top,
      documented,
      'systemSettingsResponseSchema vs the registry: documented namespaces',
    );
  });

  it('requires on a PUT exactly the namespaces declared requiredOnPut', () => {
    for (const ns of registered()) {
      const shape = updateSystemSettingsSchema.shape as Record<string, z.ZodType>;
      // A required branch rejects `undefined`; an optional one accepts it.
      expect({ key: ns.key, optionalOnPut: shape[ns.key].safeParse(undefined).success }).toEqual({
        key: ns.key,
        optionalOnPut: !ns.requiredOnPut,
      });
    }
  });

  describe.each(
    // Driven off the registry, so a namespace registered anywhere is
    // automatically checked one level deep without touching this file.
    systemSettingsNamespaceRegistry.list().map((ns) => [ns.key]),
  )('%s', (namespace: string) => {
    it('declares the same fields in every place that models it', () => {
      const expected = REFERENCE.children(namespace);
      if (expected === null) {
        // A record-shaped namespace has no fixed field set to compare — see
        // `objectKeys`. Skipped by shape rather than by name, so a future
        // record-shaped namespace needs no change here either.
        return;
      }

      // The response branch is deliberately NOT compared field by field: it is
      // the documented OpenAPI contract, which is allowed to describe fewer
      // fields than are stored (the `ai` branch has never listed
      // `reasoningEffort`, and the characterization snapshot pins that). Its
      // top-level presence is asserted above.
      for (const source of COMPLETE_SOURCES.filter((s) => s !== REFERENCE)) {
        const actual = source.children(namespace);

        // A source that does not model this namespace as an object at all is
        // already a failure of the top-level assertions above (or, for a
        // record, deliberately not comparable). Reporting it twice would only
        // obscure the first, clearer message.
        if (actual === null) {
          continue;
        }

        expectSameKeys(
          actual,
          expected,
          `${source.name} vs ${REFERENCE.name}: fields of "${namespace}"`,
        );
      }
    });

    it('declares defaults that its own stored schema accepts', () => {
      const declaration = registered().find((ns) => ns.key === namespace)!;

      expect(declaration.defaults).toBeDefined();
      expect(declaration.storedSchema.safeParse(declaration.defaults).success).toBe(true);
    });
  });

  it('gives every namespace a default, so nothing reads as undefined on a fresh deployment', () => {
    // The assertions above compare key SETS; this one is about the defaults
    // being real values. A namespace present in `DEFAULT_SYSTEM_SETTINGS` but
    // set to `undefined` would satisfy `Object.keys` and still hand
    // `readKnownSettings` nothing to degrade to.
    for (const { key } of registered()) {
      expect(
        (DEFAULT_SYSTEM_SETTINGS as unknown as Record<string, unknown>)[key],
      ).toBeDefined();
    }
  });

  it('parses its own defaults, which is what the degraded-read path relies on', () => {
    // `readKnownSettings` falls back to `DEFAULT_SYSTEM_SETTINGS` field by
    // field and the result is then handed to `systemSettingsSchema.parse`. A
    // default that does not satisfy its own schema (a `timeOfDay` of `"2:00"`,
    // a `compressionLevel` of `10`) would turn a damaged row into a settings
    // page nobody can save — the exact trap #130's degraded read exists to
    // avoid.
    expect(() => systemSettingsSchema.parse(DEFAULT_SYSTEM_SETTINGS)).not.toThrow();
  });
});

import { z } from 'zod';
import {
  systemSettingsSchema,
  systemSettingsPatchSchema,
} from './settings.schema';
import {
  updateSystemSettingsSchema,
  patchSystemSettingsSchema,
} from '../../settings/dto/update-system-settings.dto';
import { DEFAULT_SYSTEM_SETTINGS } from '../types/settings.types';

// =============================================================================
// System settings parity guard (#256, epic #254)
// =============================================================================
//
// WHAT A FAILURE HERE MEANS. A namespace, or a field inside one, exists in some
// of the places that define `system_settings` and not in the others. The
// failure message names the key and the two sources that disagree; the fix is
// always to add it to the source that is missing it, never to loosen this test.
//
// THE PLACES, AND WHAT EACH ONE BREAKS WHEN IT IS THE ONE THAT WAS MISSED:
//
//   1. `systemSettingsSchema`          common/schemas/settings.schema.ts
//        The canonical stored shape. Missing here → the service's own
//        `parse` strips the key on the way to the database, so nothing is
//        ever persisted.
//   2. `systemSettingsPatchSchema`     same file
//        The canonical partial. Missing here → the merged value fails to
//        validate, or the namespace can never be partially updated.
//   3. `updateSystemSettingsSchema`    settings/dto/update-system-settings.dto.ts
//        The PUT REQUEST BODY. Missing here → the global ZodValidationPipe
//        strips the key BEFORE the service is called. A full replacement
//        silently drops the namespace.
//   4. `patchSystemSettingsSchema`     same file
//        The PATCH REQUEST BODY, and the nastiest of the six. Missing here →
//        `PATCH { "databaseBackup": { "enabled": true } }` parses to `{}`,
//        the service merges nothing, the row is rewritten unchanged and the
//        endpoint returns 200 with a body that looks correct. No error, no
//        log line, no audit entry: the classic silent no-op this file exists
//        to prevent. (Today a namespace that is REQUIRED in (1) and merged by
//        name in the service also fails to compile, which is a welcome second
//        net — but it is a consequence of how these four happen to be written,
//        not a property of the design. A namespace merged with a spread, or
//        optional in (1), is silent again. Do not lean on the compiler here.)
//   5. `DEFAULT_SYSTEM_SETTINGS`       common/types/settings.types.ts
//        The defaults, and the only place they live. Missing here → a
//        deployment that has never saved the key reads `undefined` where
//        `SystemSettingsValue` promises a value, and `readKnownSettings` has
//        nothing to degrade to.
//
// The sixth place — the hand-written merge in
// `settings/system-settings/system-settings.service.ts` — is deliberately NOT
// checked here. It cannot be: a merge is behaviour, not a key set, and a merge
// that reads the right key and applies it wrongly has exactly the same shape as
// one that is correct. That one is covered where behaviour is covered, by
// `system-settings.service.spec.ts` and by
// `test/settings/system-settings.integration.spec.ts` (which drives a real
// PATCH through the wire DTO and asserts what reached Prisma). If you added a
// namespace and this file is green, you are five-sixths done.
//
// HOW THE KEY SETS ARE OBTAINED. Programmatically, from the zod schemas
// themselves — never from a list written out in this file. A hand-maintained
// list is the same defect one level up: it would need updating in a sixth
// place, and the day someone forgot it this test would go green while the
// endpoint was broken.
// =============================================================================

/**
 * Strip the wrappers that carry no keys of their own.
 *
 * `.optional()`, `.nullable()`, `.default()` and friends are all a box around
 * the schema that actually has a `.shape`, and every one of them appears in at
 * least one of the five sources: the PATCH schemas wrap every namespace in
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
 * `null` rather than `[]` on purpose. Every namespace `systemSettingsSchema`
 * declares today (`notifications`, `jobs`, `nodes`, `databaseBackup`,
 * `maintenance`) is a closed `z.object` with a fixed shape, so this branch
 * currently never fires — but it remains the correct guard for a namespace
 * shaped like an open `z.record` (an operator-supplied map with no fixed key
 * set, the way the removed `features` namespace was before #366). Returning
 * `[]` for one would make it look like an object with no properties and put
 * it in permanent, spurious disagreement with its own default value. `null`
 * means "not comparable", and comparison is skipped.
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
 * The five sources, each reduced to "top-level keys" plus "the keys one level
 * inside each of them".
 *
 * ONE LEVEL, not arbitrary depth. That is the depth at which the six places
 * actually restate each other — the wire DTOs, the merge and the defaults all
 * work namespace-by-field — and it is the depth at which a mistake is silent.
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

const SOURCES: Source[] = [
  schemaSource('systemSettingsSchema', systemSettingsSchema),
  schemaSource('systemSettingsPatchSchema', systemSettingsPatchSchema),
  schemaSource('updateSystemSettingsSchema (PUT body)', updateSystemSettingsSchema),
  schemaSource('patchSystemSettingsSchema (PATCH body)', patchSystemSettingsSchema),
  {
    name: 'DEFAULT_SYSTEM_SETTINGS',
    top: Object.keys(DEFAULT_SYSTEM_SETTINGS),
    children: (namespace) =>
      valueKeys(
        (DEFAULT_SYSTEM_SETTINGS as unknown as Record<string, unknown>)[
          namespace
        ],
      ),
  },
];

// The canonical stored shape is the reference every other source is compared
// against, because it is the one a stored value has to satisfy.
const [REFERENCE, ...OTHERS] = SOURCES;

/**
 * Compare two key sets and report the difference by NAME.
 *
 * Deliberately not `expect(a.sort()).toEqual(b.sort())`: that reports two lists
 * and leaves the reader to diff them. This reports the answer — which keys are
 * missing, which are unexpected — which is the whole point of a guard whose
 * failure will usually be read by someone who has just added a namespace and
 * does not yet know which of six places they missed.
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
  it('declares the same top-level namespaces everywhere', () => {
    for (const source of OTHERS) {
      expectSameKeys(
        source.top,
        REFERENCE.top,
        `${source.name} vs ${REFERENCE.name}: top-level namespaces`,
      );
    }
  });

  describe.each(
    // Driven off the reference schema, so a namespace added there is
    // automatically checked one level deep without touching this file.
    Object.keys(systemSettingsSchema.shape).map((namespace) => [namespace]),
  )('%s', (namespace: string) => {
    it('declares the same fields in every source that models it', () => {
      const expected = REFERENCE.children(namespace);
      if (expected === null) {
        // No namespace today is a record with no fixed key set to compare —
        // see `objectKeys` above — but this stays a plain `return` rather
        // than special-cased by name, so a future record-shaped namespace
        // needs no change here either.
        return;
      }

      for (const source of OTHERS) {
        const actual = source.children(namespace);

        // A source that does not model this namespace as an object at all is
        // already a failure of the top-level assertion above (or, for a
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
  });

  it('gives every namespace a default, so nothing reads as undefined on a fresh deployment', () => {
    // The parity assertions above compare key SETS; this one is about the
    // defaults being real values. A namespace present in
    // `DEFAULT_SYSTEM_SETTINGS` but set to `undefined` would satisfy
    // `Object.keys` and still hand `readKnownSettings` nothing to degrade to.
    for (const namespace of Object.keys(systemSettingsSchema.shape)) {
      expect(
        (DEFAULT_SYSTEM_SETTINGS as unknown as Record<string, unknown>)[
          namespace
        ],
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

import { z } from 'zod';
import {
  userSettingsSchema,
  userSettingsPatchSchema,
} from './settings.schema';
import {
  updateUserSettingsSchema,
  patchUserSettingsSchema,
} from '../../settings/dto/update-user-settings.dto';
import { userSettingsResponseSchema } from '../../settings/dto/user-settings-response.dto';
import {
  DEFAULT_USER_SETTINGS,
  type UserSettingsValue,
} from '../types/settings.types';

// =============================================================================
// User settings parity guard (#272, epic #271)
// =============================================================================
//
// WHAT A FAILURE HERE MEANS. A namespace, or a field inside one, exists in some
// of the places that define `user_settings` and not in the others. The failure
// message names the key and the two sources that disagree; the fix is always to
// add it to the source that is missing it, never to loosen this test.
//
// The counterpart guard for `system_settings` is settings-parity.spec.ts, and
// this file is modelled on it. It is NOT a copy: the two settings documents
// have different sources, different shapes, and — see the warning below — a
// different amount of help from the compiler.
//
// THE PLACES, AND WHAT EACH ONE BREAKS WHEN IT IS THE ONE THAT WAS MISSED:
//
//   1. `userSettingsSchema`             common/schemas/settings.schema.ts
//        The canonical stored shape. Missing here → `UserSettingsService`'s own
//        `parse` STRIPS the key on the way to the database (the call is
//        annotated in that service precisely because it is silent), so nothing
//        is ever persisted and no subsequent GET can return it.
//   2. `userSettingsPatchSchema`        same file
//        The canonical partial. Missing here → the namespace can never be
//        partially updated, or the merged value fails to validate.
//   3. `updateUserSettingsSchema`       settings/dto/update-user-settings.dto.ts
//        The PUT REQUEST BODY. Missing here → the global ZodValidationPipe
//        strips the key BEFORE the service is called, so a full replacement
//        silently drops the namespace.
//   4. `patchUserSettingsSchema`        same file
//        The PATCH REQUEST BODY, and the nastiest of the six. Missing here →
//        `PATCH { "onboarding": { "welcomeSeenAt": "..." } }` parses to `{}`,
//        the service merges nothing, the row is rewritten unchanged and the
//        endpoint returns 200 with a body that looks correct. No error, no log
//        line, no audit entry: a welcome dialog that will not stay dismissed
//        and nothing anywhere saying why.
//   5. `userSettingsResponseSchema`     settings/dto/user-settings-response.dto.ts
//        The GET/PUT/PATCH RESPONSE BODY. Missing here → the namespace is
//        writable but never readable back: it persists correctly and is then
//        stripped on the way out, so the client concludes its own write did
//        nothing. `system_settings` has no equivalent source, which is why this
//        guard checks six places against that one's five.
//   6. `UserSettingsValue`              common/types/settings.types.ts
//        The TypeScript view of the stored value. Missing here → the type and
//        the schema disagree; the service cannot assign the merged namespace
//        without a cast, and every consumer is told the key does not exist.
//
// ⚠ THE SECOND NET THAT EXISTS FOR SYSTEM SETTINGS DOES NOT EXIST HERE.
// settings-parity.spec.ts notes that a namespace REQUIRED in its source (1) and
// merged by name also fails to compile when it is missing elsewhere — "a
// welcome second net", it says, "but it is a consequence of how these four
// happen to be written, not a property of the design". EVERY USER-SETTINGS
// NAMESPACE IS OPTIONAL, by design and permanently: absent is what "the user
// has expressed no preference" is spelled as (see
// user-settings-namespaces.schema.ts). So there is nothing for the compiler to
// notice. `dataTables` and `navigation` were both added with no guard at all,
// and would have been silent in exactly this way. That makes this file MORE
// load-bearing than its system-settings sibling, not less — it is the only
// mechanism of any kind that catches the omission.
//
// The seventh place — the hand-written merge in
// `settings/user-settings/user-settings.service.ts` (`mergeOnboarding` and its
// neighbours) — is deliberately NOT checked here. It cannot be: a merge is
// behaviour, not a key set, and a merge that reads the right key and applies it
// wrongly has exactly the same shape as one that is correct. That one is
// covered where behaviour is covered, by `user-settings.service.spec.ts` and by
// `test/settings/user-settings.integration.spec.ts` (which drives a real PATCH
// through the wire DTO). If you added a namespace and this file is green, you
// are six-sevenths done.
//
// HOW THE KEY SETS ARE OBTAINED. Programmatically, from the zod schemas
// themselves — never from a list written out in this file. A hand-maintained
// list is the same defect one level up: it would be an eighth place to forget,
// and the day someone forgot it this test would go green while the endpoint was
// broken.
// =============================================================================

/**
 * Strip the wrappers that carry no keys of their own.
 *
 * `.optional()`, `.nullable()`, `.default()` and friends are all a box around
 * the schema that actually has a `.shape`, and the user-settings sources are
 * wrapped far more heavily than the system-settings ones: EVERY namespace here
 * is `.optional()` in all six sources, and the two PATCH schemas add
 * `.nullable()` on top of that (`{ "navigation": null }` clears the namespace).
 * Comparing key sets without unwrapping would compare a box against a box and
 * report nothing at all.
 */
function unwrap(schema: unknown): unknown {
  let current = schema;

  // Bounded rather than `while (true)`: a schema wrapped in itself would
  // otherwise hang the suite instead of failing it.
  for (let depth = 0; depth < 16; depth += 1) {
    const def = (
      current as {
        _def?: { type?: string; innerType?: unknown; in?: unknown };
      }
    )?._def;

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
 * `null` rather than `[]`, and unlike the system-settings guard this branch
 * fires for real today: `dataTables` and `notifications` are both `z.record` /
 * `z.partialRecord` namespaces whose keys are user data (a table id, a delivery
 * channel), not a fixed shape. Returning `[]` for one would make it look like
 * an object with no properties and put it in permanent, spurious disagreement
 * with every other source. `null` means "not comparable", and the field-level
 * comparison is skipped for that namespace — the top-level assertion still
 * covers it.
 */
function objectKeys(schema: unknown): string[] | null {
  const unwrapped = unwrap(schema);
  if (!(unwrapped instanceof z.ZodObject)) {
    return null;
  }

  return Object.keys(unwrapped.shape as Record<string, unknown>);
}

/**
 * The six sources, each reduced to "top-level keys" plus "the keys one level
 * inside each of them".
 *
 * ONE LEVEL, not arbitrary depth. That is the depth at which the six places
 * actually restate each other — both wire DTOs, the response projection and the
 * TS interface all work namespace-by-field — and it is the depth at which a
 * mistake is silent. A field one level deeper (`dataTables.<id>.density`) is
 * shared by reference from user-settings-namespaces.schema.ts and cannot drift.
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

/**
 * `userSettingsResponseSchema` also carries the two SERVER-OWNED fields
 * (`updatedAt`, `version`) that no stored value and no request body has. They
 * are not a parity failure — they are the response's own contract — so they are
 * excluded by name here rather than by loosening the comparison, which would
 * also hide a real difference.
 */
const RESPONSE_ONLY_KEYS = ['updatedAt', 'version'];

const responseSource = (): Source => {
  const base = schemaSource(
    'userSettingsResponseSchema (response body)',
    userSettingsResponseSchema,
  );
  return {
    ...base,
    top: base.top.filter((key) => !RESPONSE_ONLY_KEYS.includes(key)),
  };
};

/**
 * `UserSettingsValue` is a TypeScript interface, and an interface has no
 * runtime key set to read. It is compared by a COMPILE-TIME assertion instead,
 * below — the one source in this file that is checked by `tsc` rather than by
 * jest, because it is the one source that does not exist at runtime.
 */
const SOURCES: Source[] = [
  schemaSource('userSettingsSchema', userSettingsSchema),
  schemaSource('userSettingsPatchSchema', userSettingsPatchSchema),
  schemaSource(
    'updateUserSettingsSchema (PUT body)',
    updateUserSettingsSchema,
  ),
  schemaSource(
    'patchUserSettingsSchema (PATCH body)',
    patchUserSettingsSchema,
  ),
  responseSource(),
];

// The canonical stored shape is the reference every other source is compared
// against, because it is the one a stored value has to satisfy.
const [REFERENCE, ...OTHERS] = SOURCES;

// =============================================================================
// Source 6: `UserSettingsValue`, checked by the compiler
// =============================================================================
//
// An interface has no runtime key set, so the five assertions above cannot
// reach it. It is compared here instead, as a type-level assertion that `tsc`
// evaluates — and that ts-jest evaluates too, since this project's jest
// transform runs with diagnostics on. A namespace missing from the interface
// therefore fails BOTH `npm run typecheck` AND this spec, and the error names
// the key:
//
//     Type 'true' is not assignable to type
//       '["missing from UserSettingsValue", "onboarding"]'
//
// Two directions, because either one alone leaves a real defect invisible: a
// key in the schema but not the interface makes the merged namespace
// unassignable in the service, and a key in the interface but not the schema
// promises consumers a value `parse` will strip on every write.
// =============================================================================

type StoredShape = z.infer<typeof userSettingsSchema>;

type MissingFromInterface = Exclude<keyof StoredShape, keyof UserSettingsValue>;
type ExtraOnInterface = Exclude<keyof UserSettingsValue, keyof StoredShape>;

// Exported only so they are not unused locals — nothing should reference them.
export const INTERFACE_HAS_EVERY_SCHEMA_KEY: [MissingFromInterface] extends [
  never,
]
  ? true
  : ['missing from UserSettingsValue', MissingFromInterface] = true;

export const INTERFACE_HAS_NO_EXTRA_KEY: [ExtraOnInterface] extends [never]
  ? true
  : ['missing from userSettingsSchema', ExtraOnInterface] = true;

/**
 * Compare two key sets and report the difference by NAME.
 *
 * Deliberately not `expect(a.sort()).toEqual(b.sort())`: that reports two lists
 * and leaves the reader to diff them. This reports the answer — which keys are
 * missing, which are unexpected — which is the whole point of a guard whose
 * failure will usually be read by someone who has just added a namespace and
 * does not yet know which of the places they missed.
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

describe('user settings parity across the places a namespace must be declared', () => {
  // AGGREGATED ACROSS SOURCES, not one `expect` per source in a loop. Missing a
  // namespace in several places at once is the NORMAL failure — someone adds it
  // to the canonical schema and stops — and a loop of assertions reports only
  // whichever source it reached first, sending the reader back for another run
  // after each fix. One report names every place that is missing it.
  it('declares the same top-level namespaces everywhere', () => {
    const disagreements = OTHERS.map((source) => ({
      source: source.name,
      missing: REFERENCE.top.filter((key) => !source.top.includes(key)),
      unexpected: source.top.filter((key) => !REFERENCE.top.includes(key)),
    })).filter(
      (report) => report.missing.length > 0 || report.unexpected.length > 0,
    );

    expect({
      comparedAgainst: REFERENCE.name,
      disagreements,
    }).toEqual({ comparedAgainst: REFERENCE.name, disagreements: [] });
  });

  describe.each(
    // Driven off the reference schema, so a namespace added there is
    // automatically checked one level deep without touching this file.
    Object.keys(userSettingsSchema.shape).map((namespace) => [namespace]),
  )('%s', (namespace: string) => {
    it('declares the same fields in every source that models it', () => {
      const expected = REFERENCE.children(namespace);
      if (expected === null) {
        // A record-shaped namespace (`dataTables`, `notifications`) has no
        // fixed field set to compare — see `objectKeys`. Skipped by shape
        // rather than by name, so a future record-shaped namespace needs no
        // change here either.
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

  it('declares the same keys on the `UserSettingsValue` interface', () => {
    // The assertion that matters here is the type-level one above, evaluated
    // by the compiler; this case exists so the sixth source has a NAMED test in
    // the report rather than only an error on a `const`. If the interface and
    // the schema disagree, this file does not compile and every case in it
    // fails — with the missing key spelled out in the TS error.
    expect(INTERFACE_HAS_EVERY_SCHEMA_KEY).toBe(true);
    expect(INTERFACE_HAS_NO_EXTRA_KEY).toBe(true);
  });

  it('gives no namespace a `.default()`, so absent keeps meaning "the user has not chosen"', () => {
    // The rule the namespaces file states in capitals, asserted rather than
    // trusted. A `.default()` on any namespace would materialise it on the
    // first unrelated write — freezing a column set, pinning a user to today's
    // notification defaults, or (for `onboarding`, #272) telling an account it
    // has already been through a first run it has never seen. Every one of
    // those failures is silent.
    for (const [namespace, schema] of Object.entries(
      userSettingsSchema.shape as Record<string, unknown>,
    )) {
      // `theme` and `profile` are REQUIRED rather than defaulted, and are
      // covered by the `DEFAULT_USER_SETTINGS` assertion below; the rule under
      // test is about the optional namespaces. Checking every entry anyway
      // costs nothing and means a future required-with-default field is caught
      // too. `prefault` is zod v4's other spelling of the same idea and would
      // have the identical effect, so it counts.
      const wrappers = collectWrapperTypes(schema);
      const defaulted = wrappers.filter(
        (type) => type === 'default' || type === 'prefault',
      );

      expect({ namespace, defaulted }).toEqual({ namespace, defaulted: [] });
    }
  });

  it('defaults only `theme` and `profile`, leaving every namespace absent', () => {
    // The inverse of the system-settings guard's "gives every namespace a
    // default" assertion, and deliberately so. There, a namespace missing from
    // the defaults reads as `undefined` where the type promises a value. Here,
    // a namespace PRESENT in the defaults is the bug: it would be written into
    // every freshly created settings row by `getSettings`, so "absent" — the
    // state `dataTables`, `navigation`, `notifications` and `onboarding` all
    // read as "no preference expressed" — would never occur again.
    expect(Object.keys(DEFAULT_USER_SETTINGS).sort()).toEqual([
      'profile',
      'theme',
    ]);
  });

  it('parses its own defaults, which is what a freshly created row relies on', () => {
    // `getSettings` inserts `DEFAULT_USER_SETTINGS` verbatim for a user who has
    // none, and every write then round-trips through `userSettingsSchema.parse`.
    // A default that does not satisfy its own schema would be a settings page
    // that 400s on the first save for every new account.
    expect(() =>
      userSettingsSchema.parse(DEFAULT_USER_SETTINGS),
    ).not.toThrow();
  });
});

/**
 * The chain of wrapper types around a schema, outermost first
 * (`['optional', 'object']`).
 *
 * Used only by the no-`.default()` assertion: `unwrap` above throws the chain
 * away by design, and the question there is precisely what was in it.
 */
function collectWrapperTypes(schema: unknown): string[] {
  const types: string[] = [];
  let current = schema;

  for (let depth = 0; depth < 16; depth += 1) {
    const def = (
      current as {
        _def?: { type?: string; innerType?: unknown; in?: unknown };
      }
    )?._def;

    if (!def?.type) {
      return types;
    }

    types.push(def.type);

    switch (def.type) {
      case 'optional':
      case 'nullable':
      case 'nonoptional':
      case 'default':
      case 'prefault':
      case 'catch':
      case 'readonly':
        current = def.innerType;
        break;
      case 'pipe':
        current = def.in;
        break;
      default:
        return types;
    }
  }

  return types;
}

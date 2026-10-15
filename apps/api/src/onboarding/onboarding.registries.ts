// =============================================================================
// The onboarding step and fact registries (issue #460, step 7)
// =============================================================================
//
// Until #460 the checklist was two closed arrays in `onboarding-steps.ts`, and
// four of their entries (`admin.transcription`, `admin.smoke_test`,
// `user.first_transcript`, `user.first_note`) plus the context fields behind
// them (transcription availability, transcript and note counts) named the
// transcription, transcripts and notes modules from inside the onboarding
// module. That is a base -> domain edge, and `OnboardingModule` imported
// `TranscriptionModule` to pay for it.
//
// Now a step and a fact are each DECLARED beside the module that owns them
// (`transcription/transcription.onboarding.ts`,
// `transcripts/transcripts.onboarding.ts`, `notes/notes.onboarding.ts`) and
// REGISTERED from `apps/api/src/kvox.manifest.ts`. The onboarding module imports
// no domain code. Names mirror EnterpriseAppBase
// `platform-api/src/onboarding/onboarding.registries.ts`
// (`registerOnboardingStep`, `registerOnboardingFact`).
//
// -----------------------------------------------------------------------------
// FACTS, AND WHY THEY KEEP BOTH INVARIANTS
// -----------------------------------------------------------------------------
//
// A step still never issues its own query (`onboarding-steps.ts`, failure mode
// 2) and completion is still derived on every read (failure mode 1). A step
// that needs something a domain owns DECLARES it by id in `facts`; the service
// resolves every fact the audience's steps name ONCE per request, in the same
// parallel read pass as the base reads, BEFORE any step runs, and hands the
// values to `applies`/`evaluate` as `ctx.facts[id]`. A step stays a pure
// function of its context, and adding one still costs zero extra reads unless it
// introduces a fact nobody else uses.
//
// A fact is `{ id, inject, resolve(instance, ctx) }`. EAB's fact is
// `resolve(ctx)` over an `OnboardingDataPort`; KVox has no such port, so a fact
// names the provider it reads from (`inject`, a class token or a string token)
// and the service looks it up with `ModuleRef.get(inject, { strict: false })`,
// the same pattern the user-data hooks use. A provider that cannot be resolved
// REJECTS the request; it never silently drops a step.
//
// Static registries: filled at import time by the manifest, frozen once the
// application has bootstrapped (`RegistryFreezeService`).
// =============================================================================

import type { Type } from '@nestjs/common';

import { defineRegistry } from '../common/registry/define-registry';
import { ONBOARDING_STEP_KEY_PATTERN } from '../common/schemas/user-settings-namespaces.schema';
import type {
  OnboardingAudience,
  OnboardingContext,
  OnboardingStep,
  OnboardingTier,
} from './onboarding-steps';

/**
 * The value of every registered fact, by id. Each declaring module augments it,
 * which is what types `ctx.facts['transcription.available']` in its steps:
 *
 * ```ts
 * declare module '../onboarding/onboarding.registries' {
 *   interface OnboardingFactValues { 'transcription.available': boolean }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface OnboardingFactValues {}

/** What a fact resolver is told about the request it is resolving for. */
export interface OnboardingFactContext {
  /** The caller. A fact scopes its read to this id; it never widens it. */
  readonly callerId: string;
  /** Which checklist is being built. */
  readonly audience: OnboardingAudience;
}

/**
 * One fact a step can depend on.
 *
 * `T` is the resolved value and `I` the provider it reads from. The registry
 * stores facts with `I = any` (the instance is whatever `inject` resolves to).
 */
export interface OnboardingFactDef<T = unknown, I = any> {
  /** `<module>.<fact>`, e.g. `transcripts.ownCount`. Permanent once a step names it. */
  readonly id: string;
  /** The provider the fact reads from: a class token, or a string token. */
  readonly inject: Type<I> | string;
  /** Resolve the value for one caller. Read-only; runs once per request. */
  resolve(instance: I, ctx: OnboardingFactContext): Promise<T>;
}

const TIERS: readonly OnboardingTier[] = ['required', 'recommended', 'optional'];
const AUDIENCES: readonly OnboardingAudience[] = ['admin', 'user'];

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Every fact a registered step depends on. Facts are registered before steps
 * (the manifest orders it), so an unknown id is a wiring mistake caught at
 * registration rather than a `ctx.facts[id]` that is silently `undefined`.
 */
export const onboardingFactRegistry = defineRegistry<OnboardingFactDef>({
  name: 'onboarding.facts',
  idOf: (fact) => fact.id,
  validate: (fact) => {
    if (typeof fact.resolve !== 'function') {
      throw new Error('`resolve` must be a function');
    }
    if (fact.inject === undefined || fact.inject === null || fact.inject === '') {
      throw new Error('`inject` must name the provider the fact reads from');
    }
  },
});

/**
 * Every checklist step, both audiences, rendered in `(order, key)` order.
 *
 * `order` is per audience (10, 20, 30, ...): the two checklists share one
 * registry but never one sequence, so a gap between neighbours is room to
 * insert a step without renumbering the others.
 */
export const onboardingStepRegistry = defineRegistry<OnboardingStep>({
  name: 'onboarding.steps',
  idOf: (step) => step.key,
  // The key is persisted in `onboarding.skipped[]`: a key the namespace's own
  // bound rejects is a step that cannot be skipped (see `OnboardingStep.key`).
  idPattern: ONBOARDING_STEP_KEY_PATTERN,
  order: (a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  validate: (step) => {
    if (!AUDIENCES.includes(step.audience)) {
      throw new Error(`\`audience\` must be one of ${AUDIENCES.join(', ')}`);
    }
    if (!TIERS.includes(step.tier)) {
      throw new Error(`\`tier\` must be one of ${TIERS.join(', ')}`);
    }
    for (const field of ['title', 'description', 'actionLabel'] as const) {
      if (!nonEmptyString(step[field])) {
        throw new Error(`\`${field}\` must be a non-empty string`);
      }
    }
    // Root-relative only: the web app navigates to it without a protocol check.
    if (
      typeof step.href !== 'string' ||
      !step.href.startsWith('/') ||
      step.href.startsWith('//')
    ) {
      throw new Error('`href` must be a root-relative path');
    }
    if (typeof step.order !== 'number' || !Number.isFinite(step.order)) {
      throw new Error('`order` must be a finite number');
    }
    if (typeof step.skippable !== 'boolean') {
      throw new Error('`skippable` must be a boolean');
    }
    // A `required` step feeds `requiredRemaining`/`allRequiredSatisfied`; one the
    // user could dismiss would let them switch off a warning about a deployment
    // that cannot do its job (see `OnboardingStep.skippable`).
    if (step.tier === 'required' && step.skippable) {
      throw new Error('a `required` step must not be skippable');
    }
    if (!Array.isArray(step.facts)) {
      throw new Error('`facts` must be an array of fact ids');
    }
    for (const id of step.facts) {
      if (!onboardingFactRegistry.has(id)) {
        throw new Error(
          `unknown fact "${id}": register it with registerOnboardingFact before the step`,
        );
      }
    }
    if (typeof step.evaluate !== 'function') {
      throw new Error('`evaluate` must be a function');
    }
    if (typeof step.applies !== 'function') {
      throw new Error('`applies` must be a function');
    }
  },
});

/** Register facts. Call before the steps that name them. */
export function registerOnboardingFact(...facts: OnboardingFactDef[]): void {
  onboardingFactRegistry.registerAll(facts);
}

/** Register steps, all or nothing. */
export function registerOnboardingStep(...steps: OnboardingStep[]): void {
  onboardingStepRegistry.registerAll(steps);
}

/** The registered steps of one audience, in rendered order. */
export function onboardingStepsFor<Ctx extends OnboardingContext = OnboardingContext>(
  audience: OnboardingAudience,
): OnboardingStep<Ctx>[] {
  return onboardingStepRegistry
    .list()
    .filter((step) => step.audience === audience) as OnboardingStep<Ctx>[];
}

/**
 * A read-only array that re-reads `read()` on every access.
 *
 * Exists for `ADMIN_ONBOARDING_STEPS`/`USER_ONBOARDING_STEPS`, which specs and
 * the characterization snapshot import by name and which are now registry views:
 * a plain exported array would be evaluated at import time, before the manifest
 * has registered the domain steps. Not for production reads (the service calls
 * {@link onboardingStepsFor}).
 */
export function liveArray<T>(read: () => readonly T[]): readonly T[] {
  return new Proxy([] as T[], {
    get: (_target, prop) => Reflect.get(read() as T[], prop),
    has: (_target, prop) => Reflect.has(read() as T[], prop),
    ownKeys: () => Reflect.ownKeys(read() as T[]),
    getOwnPropertyDescriptor: (_target, prop) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(read() as T[], prop);
      // A Proxy over `[]` must report `length` as the non-configurable property
      // the target has; every other property may be reported configurable.
      return descriptor && prop !== 'length' ? { ...descriptor, configurable: true } : descriptor;
    },
    set: () => false,
    deleteProperty: () => false,
  });
}

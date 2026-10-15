// =============================================================================
// User-data category and scope registries (issue #460, mirrors EnterpriseAppBase
// `user-data/user-data.registries.ts`)
// =============================================================================
//
// The Danger Zone used to name every domain by hand: `scopeIncludes` switched on
// `'transcripts' | 'notes' | 'noteTemplates' | 'graph' | 'ask'`, the summary read
// six domain tables, and the purge handler imported four domain services. This
// file inverts that. A CATEGORY is "one kind of data a user owns": its domain
// declares it, beside its own module, together with the two hooks that make it
// real (how to COUNT it, how to DELETE it). A SCOPE is "what a user may ask to be
// forgotten": a named set of categories.
//
// Field names (`id`, `label`, `description`, `content`, `order`, `categories`,
// `confirmation`, `layer`) match the platform's so a later swap changes the import
// path and nothing else. The two hooks (`summary`, `purge`) are KVox's own: the
// platform drives its categories from Prisma model hints, KVox's are hand-written
// and ordered (see below).
//
// -----------------------------------------------------------------------------
// ⚠ TWO ORDERS, BOTH WIRE-VISIBLE OR LOAD-BEARING, AND THEY ARE NOT THE SAME
// -----------------------------------------------------------------------------
//
//   • `UserDataCategoryDef.order` is the LISTING order: the key order of
//     `GET /api/user-data/summary` (transcripts, notes, files, noteTemplates,
//     credentials, graph, askConversations, then `activeDeletion` last).
//   • `UserDataCategoryDef.purge.order` is the EXECUTION order of
//     `user.data.purge`, and it is not stylistic: reference-clearing steps must
//     precede the deletes they unblock (`docs/specs/user-data-deletion.md` §4).
//     Today's order, which a registration must never reshuffle, is ask 10,
//     graph 20, credentials 30, notes 40, transcripts 50, noteTemplates 60,
//     files 70, onboarding 80.
//
// -----------------------------------------------------------------------------
// HOOKS ARE INJECTED, NEVER IMPORTED
// -----------------------------------------------------------------------------
//
// A hook names the provider that implements it (`inject`: a class or a token);
// the user-data module resolves it with `ModuleRef.get(inject, { strict: false })`
// and hands the INSTANCE to `run`. That is what lets `user-data/` import no
// domain module: the hook classes live in their domains and are provided by
// their domain modules, which are in the application graph through `AppModule`.
// A hook that cannot be resolved FAILS the job — a category is never skipped
// silently (see `resolveUserDataHook`).
//
// Static registries: filled by `kvox.manifest.ts` at import time, frozen by
// `RegistryFreezeService` after bootstrap. Framework-free: zod types and the
// registry primitive only.
// =============================================================================

import type { Type } from '@nestjs/common';
import type { z } from 'zod';

import { defineRegistry } from '../common/registry/define-registry';

/** What `purge.run` is told about the job it runs inside. */
export interface UserDataPurgeContext {
  readonly jobId: string;
  readonly scope: string;
}

/** A provider reference: a class, or an injection token string. */
export type UserDataHookInject = Type<unknown> | string;

/**
 * One kind of data a user owns.
 *
 * `instance` is `any` on purpose: the registry stores heterogeneous hook classes
 * and the typed call lives in the declaring file's closure
 * (`run: (hooks: AskUserDataHooks, userId) => hooks.purgeConversations(userId)`).
 */
export interface UserDataCategoryDef {
  /** Stable key; the `scopeIncludes` category name. camelCase (`noteTemplates`). */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /**
   * Whether the `content` scope ("everything you MADE") reaches this category.
   * `false` for state the application wrote ABOUT the user (credentials,
   * onboarding intent): only the `all` scope (`everything`) reaches those.
   */
  readonly content: boolean;
  /** Listing order (summary key order). Default: after every ordered entry, in registration order. */
  readonly order?: number;
  /** The category's branch of `GET /api/user-data/summary`. Absent for a category with no inventory. */
  readonly summary?: {
    /** The key in the response (`askConversations` for the `ask` category). */
    readonly key: string;
    /** The response branch, composed into the published OpenAPI schema. */
    readonly schema: z.ZodType;
    readonly inject: UserDataHookInject;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run(instance: any, userId: string): Promise<unknown>;
  };
  /** The category's destructive step in `user.data.purge`. Absent for a category nothing deletes. */
  readonly purge?: {
    /** Execution order; unique across categories. See the header: this is load-bearing. */
    readonly order: number;
    readonly inject: UserDataHookInject;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run(instance: any, userId: string, ctx: UserDataPurgeContext): Promise<void>;
  };
}

/** `'content'`: every category with `content: true`. `'all'`: every category. */
export type UserDataScopeCategories = readonly string[] | 'content' | 'all';

/**
 * What a user may ask to be forgotten.
 *
 * ⚠ THE ID IS PERMANENT ONCE A JOB CARRIES IT: a `user.data.purge` payload
 * records the scope as plain text, and a handler running days later against a
 * renamed scope would silently widen or narrow what it destroys.
 */
export interface UserDataScopeDef {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly categories: UserDataScopeCategories;
  /** The word a caller must type. Must equal `id.toUpperCase()` — enforced at registration. */
  readonly confirmation: string;
  readonly layer: 'user';
  /** Listing order (the UI renders scopes narrowest-first). */
  readonly order?: number;
}

const CATEGORY_ID_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const SCOPE_ID_PATTERN = /^[a-z][a-z0-9]*$/;
/** Sorts entries without an `order` after every ordered one; ties keep registration order. */
const UNORDERED = Number.MAX_SAFE_INTEGER;

function nonEmpty(value: unknown, what: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what} must be a non-empty string`);
  }
}

/** The response key `GET /api/user-data/summary` reserves for the in-flight deletion. */
export const USER_DATA_ACTIVE_DELETION_KEY = 'activeDeletion';

export const userDataCategoryRegistry = defineRegistry<UserDataCategoryDef>({
  name: 'user-data-categories',
  idOf: (def) => def.id,
  idPattern: CATEGORY_ID_PATTERN,
  order: (a, b) => (a.order ?? UNORDERED) - (b.order ?? UNORDERED),
  validate(def, registry) {
    nonEmpty(def.label, 'label');
    nonEmpty(def.description, 'description');
    if (typeof def.content !== 'boolean') throw new Error('content must be a boolean');
    if (def.order !== undefined && !Number.isFinite(def.order)) {
      throw new Error('order must be a finite number');
    }

    if (def.summary) {
      nonEmpty(def.summary.key, 'summary.key');
      if (def.summary.key === USER_DATA_ACTIVE_DELETION_KEY) {
        throw new Error(`summary.key "${USER_DATA_ACTIVE_DELETION_KEY}" is reserved`);
      }
      if (typeof def.summary.run !== 'function') throw new Error('summary.run must be a function');
      if (def.summary.inject === undefined) throw new Error('summary.inject is required');
      if (typeof (def.summary.schema as { safeParse?: unknown })?.safeParse !== 'function') {
        throw new Error('summary.schema must be a zod schema');
      }
      for (const other of registry.list()) {
        if (other.summary?.key === def.summary.key) {
          throw new Error(
            `summary.key "${def.summary.key}" is already used by category "${other.id}"`,
          );
        }
      }
    }

    if (def.purge) {
      if (!Number.isInteger(def.purge.order)) throw new Error('purge.order must be an integer');
      if (typeof def.purge.run !== 'function') throw new Error('purge.run must be a function');
      if (def.purge.inject === undefined) throw new Error('purge.inject is required');
      for (const other of registry.list()) {
        if (other.purge?.order === def.purge.order) {
          // ⚠ A TIE WOULD MAKE THE FK-CLEARING ORDER DEPEND ON REGISTRATION ORDER.
          throw new Error(
            `purge.order ${def.purge.order} is already used by category "${other.id}"`,
          );
        }
      }
    }
  },
});

export const userDataScopeRegistry = defineRegistry<UserDataScopeDef>({
  name: 'user-data-scopes',
  idOf: (def) => def.id,
  idPattern: SCOPE_ID_PATTERN,
  order: (a, b) => (a.order ?? UNORDERED) - (b.order ?? UNORDERED),
  validate(def) {
    nonEmpty(def.label, 'label');
    nonEmpty(def.description, 'description');
    if (def.layer !== 'user') throw new Error('layer must be "user"');
    if (def.order !== undefined && !Number.isFinite(def.order)) {
      throw new Error('order must be a finite number');
    }

    // ⚠ THE CONFIRMATION RULE: the scope, uppercased. A single shared word
    // would let a token typed into the "delete my files" dialog authorise the
    // `everything` request the user's second click actually sent.
    if (def.confirmation !== def.id.toUpperCase()) {
      throw new Error(`confirmation must be the scope uppercased ("${def.id.toUpperCase()}")`);
    }

    const { categories } = def;
    if (categories !== 'content' && categories !== 'all') {
      if (!Array.isArray(categories) || categories.length === 0) {
        throw new Error('categories must be "content", "all" or a non-empty array of category ids');
      }
      if (new Set(categories).size !== categories.length) {
        throw new Error('categories must not repeat an id');
      }
    }
  },
});

/** Registers one category. @throws RegistryError (`DUPLICATE_ID`, `INVALID_ENTRY`, `FROZEN`, ...). */
export function registerUserDataCategory(def: UserDataCategoryDef): void {
  userDataCategoryRegistry.register(def);
}

/** Registers one scope. @throws RegistryError (`DUPLICATE_ID`, `INVALID_ENTRY`, `FROZEN`, ...). */
export function registerUserDataScope(def: UserDataScopeDef): void {
  userDataScopeRegistry.register(def);
}

/** Every registered category, in listing order. */
export function userDataCategories(): UserDataCategoryDef[] {
  return userDataCategoryRegistry.list();
}

/** Every registered scope id, in listing order (narrowest first). */
export function userDataScopeIds(): string[] {
  return userDataScopeRegistry.ids();
}

/**
 * Whether `scope` reaches `category`. Total: an unknown scope or category is
 * `false` (a payload naming a scope this build does not have is refused earlier,
 * by `readPurgePayload`, so this fall-through never reads as "deleted nothing and
 * succeeded" for a real request).
 */
export function userDataScopeReaches(scope: string, category: string): boolean {
  const scopeDef = userDataScopeRegistry.get(scope);
  const categoryDef = userDataCategoryRegistry.get(category);

  if (!scopeDef || !categoryDef) return false;
  if (scopeDef.categories === 'all') return true;
  if (scopeDef.categories === 'content') return categoryDef.content;
  return scopeDef.categories.includes(category);
}

/** The categories `user.data.purge` runs for `scope`, in EXECUTION order. */
export function userDataPurgeSteps(scope: string): UserDataCategoryDef[] {
  return userDataCategoryRegistry
    .list()
    .filter((category) => category.purge !== undefined && userDataScopeReaches(scope, category.id))
    .sort((a, b) => (a.purge?.order ?? 0) - (b.purge?.order ?? 0));
}

/**
 * Refuses an inconsistent registration set: a scope naming a category nothing
 * registered. A typo there would not fail anywhere else — the scope would simply
 * delete less than its confirmation dialog promised. Called on boot by the purge
 * handler.
 */
export function assertUserDataRegistriesConsistent(): void {
  for (const scope of userDataScopeRegistry.list()) {
    if (scope.categories === 'content' || scope.categories === 'all') continue;
    for (const category of scope.categories) {
      if (!userDataCategoryRegistry.has(category)) {
        throw new Error(
          `User-data scope "${scope.id}" names category "${category}", which is not registered.`,
        );
      }
    }
  }
}

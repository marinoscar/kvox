// =============================================================================
// Registry test kit (issue #459). Import ONLY from specs.
// =============================================================================
//
// Static registries are frozen once a Nest application has bootstrapped and a
// Jest worker shares one module graph. A spec that needs a different registry
// state resets it here. Deliberately NOT exported from `./index`, and refused
// outside a test runner so no production path can unfreeze a registry.
// =============================================================================

import type { Registry } from './define-registry';

function insideTestRunner(): boolean {
  return Boolean(process.env.JEST_WORKER_ID || process.env.VITEST);
}

function assertTestRunner(what: string, registry: Registry<unknown>): void {
  if (!insideTestRunner()) {
    throw new Error(
      `${what}(${registry.name}) is a test helper: it runs only under Jest or Vitest ` +
        '(JEST_WORKER_ID or VITEST must be set).',
    );
  }
}

/**
 * Empties `registry` and unfreezes it. Only for a registry's own spec or a
 * spec that owns the whole process state; never call it from production code.
 */
export function resetRegistryForTests<T>(registry: Registry<T>): void {
  assertTestRunner('resetRegistryForTests', registry as Registry<unknown>);
  registry._clear();
}

/**
 * Adds `entries` to `registry` for the duration of `fn`, then restores the
 * previous entries and frozen state, even if `fn` throws.
 */
export async function withTemporaryEntries<T, R>(
  registry: Registry<T>,
  entries: readonly T[],
  fn: () => R | Promise<R>,
): Promise<R> {
  assertTestRunner('withTemporaryEntries', registry as Registry<unknown>);

  const saved = registry._captureState();
  registry._unfreeze();

  try {
    registry.registerAll(entries);
    return await fn();
  } finally {
    registry._restoreState(saved);
  }
}

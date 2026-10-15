// =============================================================================
// Job-type label registry (issue #460, mirrors EnterpriseAppBase
// `jobs/job-type-label.ts`)
// =============================================================================
//
// `Job.type` is a machine key; the admin dashboard shows a phrase. The base
// declares the labels of the types it ships (`job-type-labels.ts`), every
// domain declares its own beside its module, and `src/kvox.manifest.ts`
// registers them all here. Nothing in `jobs/` names a domain job type.
//
// AN UNMAPPED TYPE RENDERS AS ITSELF, NEVER BLANK. A fork adds handlers this
// repository has never heard of, and a `jobs` row can name a type no handler
// registers any more (rows outlive handlers), so {@link jobTypeLabel} is total:
// every string in, a non-empty string out. See the header of
// `job-type-labels.ts` for the rejected alternative (a required `label` field
// on `JobHandler`).
//
// The registry is STATIC: filled at import time by the manifest, frozen by
// `RegistryFreezeService` after bootstrap. Registering a type twice throws
// `DUPLICATE_ID`, registering after bootstrap throws `FROZEN`.
// =============================================================================

import { defineRegistry } from '../common/registry';

export interface JobTypeLabelEntry {
  /** The permanent `Job.type` string, e.g. `'note.generate'`. */
  readonly type: string;
  /** A short sentence-case phrase sized for a table cell. */
  readonly label: string;
}

export const jobTypeLabelRegistry = defineRegistry<JobTypeLabelEntry>({
  name: 'job-type-labels',
  idOf: (entry) => entry.type,
  validate: (entry) => {
    if (typeof entry.label !== 'string' || entry.label.trim().length === 0) {
      throw new Error(`the label for job type "${entry.type}" must be a non-empty string`);
    }
  },
});

/** Registers one label. @throws RegistryError on a duplicate type, an empty label or after freeze. */
export function registerJobTypeLabel(type: string, label: string): void {
  jobTypeLabelRegistry.register({ type, label });
}

/** Registers every `type -> label` pair of `labels`, all or nothing, in key order. */
export function registerJobTypeLabels(labels: Readonly<Record<string, string>>): void {
  jobTypeLabelRegistry.registerAll(
    Object.entries(labels).map(([type, label]) => ({ type, label })),
  );
}

/**
 * The display label for `type`, falling back to `type` itself.
 *
 * Total by construction: callers never write their own `?? type`, which keeps
 * the fallback from being applied in some views and forgotten in others.
 */
export function jobTypeLabel(type: string): string {
  return jobTypeLabelRegistry.get(type)?.label ?? type;
}

/**
 * Every registered `type -> label` pair as a plain record, in registration
 * order. A fresh object on each call.
 */
export function jobTypeLabels(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of jobTypeLabelRegistry.list()) out[entry.type] = entry.label;
  return out;
}

/**
 * A read-only, LIVE view of the registry shaped like the pre-registry
 * `JOB_TYPE_LABELS` record, so `JOB_TYPE_LABELS[type]` and
 * `Object.entries(JOB_TYPE_LABELS)` keep working. New code calls
 * {@link jobTypeLabel}.
 */
export const JOB_TYPE_LABELS: Readonly<Record<string, string>> = new Proxy(
  {} as Record<string, string>,
  {
    get: (_t, prop) =>
      typeof prop === 'string' ? jobTypeLabelRegistry.get(prop)?.label : undefined,
    has: (_t, prop) => typeof prop === 'string' && jobTypeLabelRegistry.has(prop),
    ownKeys: () => jobTypeLabelRegistry.ids(),
    getOwnPropertyDescriptor: (_t, prop) => {
      if (typeof prop !== 'string') return undefined;
      const entry = jobTypeLabelRegistry.get(prop);
      return entry
        ? { value: entry.label, enumerable: true, configurable: true, writable: false }
        : undefined;
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  },
);

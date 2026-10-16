// =============================================================================
// This app's job registrations (issue #468, epic #467)
// =============================================================================
//
// What this app adds to the platform's jobs and nodes slices through their
// registries:
//
//   * enqueue reasons beyond the built-in `upload`, `rerun` and `backfill`:
//     none, this app uses only those three;
//   * retention policies for the nightly retention purge: none;
//   * node span attributes a worker node may relay: none;
//   * the labels of RETIRED job types, so an old row still renders with a name in
//     the admin Jobs list after its handler is gone;
//   * the label of a platform job type whose handler declares none
//     (`sharing.grants.prune`).
//
// A live handler declares its own `label`; the registry records it when the
// handler registers. Only a type with no handler needs a line here.
//
// IMPORTED BY `platform/jobs/jobs.config.ts` and `registrations.ts`, so it runs
// before the application is created (the registries freeze when it bootstraps).
// Registering a label twice with the same text is harmless, so the double import
// needs no guard.
// =============================================================================

import {
  registerJobReason,
  registerJobTypeLabel,
  registerRetentionPolicy,
  type JobReasonDefinition,
  type RetentionPolicyDefinition,
} from '@marinoscar/platform-api/jobs';
import {
  registerNodeSpanAttribute,
  type NodeSpanAttributeDefinition,
} from '@marinoscar/platform-api/nodes';

/** Extra enqueue reasons. Empty: `upload`, `rerun` and `backfill` are built in. */
export const APP_JOB_REASONS: readonly JobReasonDefinition[] = [];

/** Retention policies this app adds to the platform's. */
export const APP_RETENTION_POLICIES: readonly RetentionPolicyDefinition[] = [];

/** Span attributes a worker node may relay beyond the platform's built-ins. */
export const APP_NODE_SPAN_ATTRIBUTES: readonly NodeSpanAttributeDefinition[] = [];

/**
 * The example handlers this app once shipped as a worked sample. Rows of both
 * types may still sit in `jobs`, so the labels stay; the handlers are gone and
 * the types are never enqueued again.
 */
export const RETIRED_JOB_TYPE_LABELS: Readonly<Record<string, string>> = {
  'example.echo': 'Example: echo (retired)',
  'example.checksum': 'Example: checksum (retired)',
};

/**
 * Labels for platform job types whose handler declares none. The sharing slice's
 * prune job (issue #485) is server-only housekeeping the admin Jobs list shows.
 */
export const PLATFORM_JOB_TYPE_LABELS: Readonly<Record<string, string>> = {
  'sharing.grants.prune': 'Sharing: prune revoked and expired grants',
};

let registered = false;

if (!registered) {
  registered = true;
  APP_JOB_REASONS.forEach(registerJobReason);
  APP_RETENTION_POLICIES.forEach(registerRetentionPolicy);
  APP_NODE_SPAN_ATTRIBUTES.forEach(registerNodeSpanAttribute);
  for (const [type, label] of Object.entries({ ...RETIRED_JOB_TYPE_LABELS, ...PLATFORM_JOB_TYPE_LABELS })) {
    registerJobTypeLabel(type, label);
  }
}

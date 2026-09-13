// =============================================================================
// OpenAPI tag taxonomy (issue #53)
// =============================================================================
//
// The single declaration of every `@ApiTags(...)` name used in this API, its
// human description, and which sidebar section it belongs to.
//
// The tag NAMES here were already consistent across the ten controllers, so
// unlike the rest of this pass nothing was renamed. What was missing is what
// this file adds: a description for each (an undescribed tag renders as a bare
// heading) and a grouping (an ungrouped tag renders outside every section).
//
// One rule this file exists to enforce: NO undeclared and NO orphaned tags. A
// tag used by a controller but not listed here would render with no description
// and land outside every group; a tag listed here but used by nobody would
// render an empty section. Both are failed assertions in
// `test/openapi/openapi-document.spec.ts` rather than something a reviewer has
// to notice.
//
// Ordering is deliberate: `TAG_GROUPS` is emitted as `x-tagGroups`, and the
// flattened tag order becomes the document's `tags` array, which is what a
// renderer falls back to when it has no group support.
// =============================================================================

export interface OpenApiTag {
  /** Must match the controller's `@ApiTags(...)` argument byte-for-byte. */
  name: string;
  /** One or two sentences. Rendered under the section heading in the sidebar. */
  description: string;
}

export interface OpenApiTagGroup {
  name: string;
  tags: OpenApiTag[];
}

/**
 * Sidebar sections, in render order.
 *
 * A group is a product area rather than a module boundary — `Allowlist` sits
 * with authentication because it gates sign-in, even though it is administered
 * from the same screen as `Users`.
 */
export const TAG_GROUPS: OpenApiTagGroup[] = [
  {
    name: 'Authentication & Access',
    tags: [
      {
        name: 'Authentication',
        description:
          'Google OAuth sign-in, access-token refresh, logout, and the current-user lookup. ' +
          'Start here: every other section assumes a bearer token obtained through one of these routes.',
      },
      {
        name: 'Device Authorization',
        description:
          'RFC 8628 device authorization grant — how a CLI or other browserless client obtains a ' +
          'token by showing the user a code to approve elsewhere, plus management of the resulting ' +
          'device sessions.',
      },
      {
        name: 'Personal Access Tokens',
        description:
          'Long-lived `pat_` bearer credentials for scripts and automation. A PAT carries the full ' +
          'permission set of the user that minted it and is accepted on every authenticated route.',
      },
      {
        name: 'Allowlist',
        description:
          'Pre-authorized email addresses. Access is allowlist-gated: an email absent from this list ' +
          'cannot complete OAuth sign-in at all. Admin only.',
      },
      {
        name: 'Test Authentication',
        description:
          'Token minting for automated tests. The module is registered only when ' +
          '`NODE_ENV !== "production"`, so these routes are absent from a production document entirely.',
      },
    ],
  },
  {
    name: 'Account & Settings',
    tags: [
      {
        name: 'Users',
        description:
          'User administration: listing, inspecting, activating and deactivating accounts, and ' +
          'assigning system roles. Admin only.',
      },
      {
        name: 'User Settings',
        description:
          'The calling user\'s own preferences, stored as a JSON document. Supports full replacement ' +
          '(`PUT`) and JSON Merge Patch (`PATCH`).',
      },
      {
        name: 'System Settings',
        description:
          'Deployment-wide configuration, stored as a JSON document. Readable by any signed-in user; ' +
          'writable only with `system_settings:write`.',
      },
      {
        name: 'Email Settings',
        description:
          'Mail transport configuration (SES or SMTP), the sender identity, and a test send that ' +
          'reports the provider\'s actual error so a misconfiguration can be diagnosed. Gated on ' +
          '`system_settings:read`/`:write`. The SMTP password is write-only: it is held in the ' +
          'encrypted credential store, is never returned, and submitting it empty preserves it.',
      },
      {
        name: 'Notifications',
        description:
          'The registry of events this application can raise, and which channels each supports. ' +
          'Readable by any signed-in user, because every user renders their own notification ' +
          'preferences against it.',
      },
      {
        name: 'Push Configuration',
        description:
          'Runtime-configurable Web Push (VAPID) keys: generate, rotate, enable/disable and ' +
          'remove, with no restart required. Gated on `push:read`/`push:write`, separately from ' +
          '`system_settings:*`, because rotating or removing the key pair knocks every existing ' +
          'push subscriber offline until they resubscribe — a materially different act from an ' +
          'ordinary settings edit. The VAPID private key is write-only: it is held in the ' +
          'encrypted credential store and is never returned by any endpoint.',
      },
    ],
  },
  {
    name: 'Storage',
    tags: [
      {
        name: 'Storage',
        description:
          'File objects: simple upload, resumable multipart upload, signed download URLs, metadata, ' +
          'and deletion. A caller sees only the objects they uploaded.',
      },
    ],
  },
  {
    name: 'Operations',
    tags: [
      {
        name: 'Health',
        description:
          'Liveness and readiness probes for orchestrators and load balancers. Public — a probe that ' +
          'needed a token could not report that authentication is down.',
      },
      // ----------------------------------------------------------------------
      // Reserved ahead of their controllers (#256, epic #254)
      // ----------------------------------------------------------------------
      //
      // The four tags below are declared before any operation carries them, so
      // that the epic's later issues add a controller and not a taxonomy
      // argument. That is safe here and needs no exception in the tests:
      // `applyTagGroups` (openapi/document.ts) publishes only the tags an
      // operation actually uses, so an unused declaration is PRUNED from
      // `document.tags` and from `x-tagGroups` rather than rendering an empty
      // section. `test/openapi/openapi-document.spec.ts` asserts orphans
      // against the PUBLISHED tags for exactly that reason — the same mechanism
      // that already lets `Test Authentication` be declared here and absent
      // from a production document.
      //
      // The rule that has no slack is the other direction: a tag USED by a
      // controller and missing from this file is undeclared, undescribed and
      // ungrouped, and that assertion stays strict. So each issue below adds
      // its operations to a tag that is already described and already grouped.
      {
        name: 'Jobs',
        description:
          'The background job queue: what is queued, running, finished or failed, and the controls ' +
          'to retry or cancel a job. Gated on `jobs:read`/`jobs:write`.',
      },
      {
        name: 'Worker Nodes',
        description:
          'The worker fleet that executes queued jobs — registration, heartbeats, health, and ' +
          'draining a node before it is retired. Gated on `nodes:read`/`nodes:write`, separately ' +
          'from the queue itself.',
      },
      {
        name: 'Database Backup',
        description:
          'Scheduled database backups, their history, and restore. Reading and scheduling are ' +
          '`db_backup:read`/`db_backup:write`; restoring requires `db_backup:restore`, which is a ' +
          'permission of its own because it renames the live database and restarts the process.',
      },
      {
        name: 'Notification Broadcasts',
        description:
          'Announcements an administrator composes and sends to every active user, immediately ' +
          'or on a schedule, over the channels the deployment supports. Gated on ' +
          '`broadcasts:read`/`broadcasts:write`, separately from `Notifications` — that section ' +
          'is every signed-in user\'s own preferences and registry, this one sends to all of ' +
          'them. Grouped with Operations rather than with Account & Settings because a ' +
          'broadcast is an operational action (maintenance windows, incident updates, policy ' +
          'changes), not a per-account setting.',
      },
      {
        name: 'Maintenance',
        description:
          'The maintenance window: turning it on, the message callers see while it is open, and ' +
          'whether administrators keep access. Gated on `system_settings:write`.',
      },
    ],
  },
];

/** Flattened, in group order. Emitted as the document's `tags` array. */
export const OPENAPI_TAGS: OpenApiTag[] = TAG_GROUPS.flatMap((group) => group.tags);

/** Emitted as `x-tagGroups`, the extension Scalar and Redoc read. */
export const OPENAPI_TAG_GROUPS = TAG_GROUPS.map((group) => ({
  name: group.name,
  tags: group.tags.map((tag) => tag.name),
}));

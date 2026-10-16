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
// render an empty section. Both are failed assertions in the OpenAPI document
// tests rather than something a reviewer has to notice.
//
// Ordering is deliberate: `TAG_GROUPS` is emitted as `x-tagGroups`, and the
// flattened tag order becomes the document's `tags` array, which is what a
// renderer falls back to when it has no group support.
//
// SINCE #464 the document is built by the platform (`createOpenApiDocument` in
// `@marinoscar/platform-api/host`), which publishes the taxonomy held in core's
// `openApiTags` registry and prunes tags no operation uses. This file registers
// every tag into it when it is first imported (`./document.ts` imports it), which
// must happen before the application bootstraps: the registry freezes then.
// =============================================================================

import { openApiTags } from '@marinoscar/platform-api/core';

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
        name: 'Roles',
        description:
          'The roles the invite, member and user-role routes may assign (`GET /api/roles?scope=system|org`), ' +
          'with their display labels. Served by the platform identity slice.',
      },
      {
        name: 'Organizations',
        description:
          'Organizations, members and invitations, served by the platform identity slice. This app runs in ' +
          'single-organization mode: the web app does not surface these routes, and the deployment has one ' +
          'organization everyone joins on first sign-in.',
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
        name: 'Onboarding',
        description:
          'First-run checklists: what this deployment still has to be configured with, and what ' +
          'the calling account still has to do. Two routes on two prefixes — `GET /api/onboarding` ' +
          'is the caller\'s own and carries no permission string (ownership-scoped, readable by a ' +
          'Viewer), `GET /api/admin/onboarding` is the deployment\'s and is gated on ' +
          '`system_settings:read`. Every status is derived on each read and nothing about ' +
          'completion is stored, so a rotated credential flips its step back rather than leaving a ' +
          'green tick over a deployment that no longer works.',
      },
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
        name: 'User Data',
        description:
          'The Danger Zone: an inventory of the data this deployment holds for the calling user, ' +
          'and bulk, irreversible deletion of it. Ownership-scoped rather than permission-gated ' +
          '— both routes are `@Auth()` with no permission string, because the resource is the ' +
          "caller's own data and no role should decide whether a person may delete it. Nothing " +
          'here deletes the ACCOUNT: the user record, their settings, roles and session all ' +
          'survive every scope.',
      },
      {
        name: 'System Settings',
        description:
          'Deployment-wide configuration, stored as a JSON document. Readable by any signed-in user; ' +
          'writable only with `system_settings:write`.',
      },
      {
        name: 'Organization Settings',
        description:
          'One organization\'s overrides of the organization-overridable system settings (platform ' +
          '`/api/org-settings`, mounted by #466). Gated on `org_settings:read` / `org_settings:write`. ' +
          'This app runs a single organization with no overrides, so the stored document stays empty.',
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
        name: 'Transcription',
        description:
          'Speech-to-text: which provider this deployment uses, its region and model, how ' +
          'audio reaches it, and what happens to it afterwards. The admin half is gated on ' +
          '`system_settings:read`/`:write`, because this configuration IS a namespace of the ' +
          'system settings row; `GET /api/transcription/config` alongside it is a narrow ' +
          'capability probe readable by any signed-in user, exactly like ' +
          '`GET /api/notifications/config`. The provider API key is write-only: it is held in ' +
          'the encrypted credential store, is never returned by any endpoint, and submitting ' +
          'it empty preserves the stored value.',
      },
      {
        name: 'AI',
        description:
          'The platform AI slice (epic #472): the capability probe (`GET /api/ai/config`), a ' +
          'user\'s OWN provider keys (`/api/ai/keys`), the responses, embeddings, images, audio, ' +
          'realtime and runs routes, the registered features (`GET /api/ai/features`) and the ' +
          'caller\'s usage. Every route is gated on `ai:use` and the deployment kill switch.\n\n' +
          'The older routes this application kept until the migration completes ' +
          '(`/api/ai-settings`, gated on `system_settings:read`/`:write`, and ' +
          '`/api/ai-credentials`, the per-user key store) share this section.\n\n' +
          '⚠ **Keys are per-user, and there is deliberately no deployment fallback key by ' +
          'default.** A key is encrypted at rest, is never returned by any endpoint to anyone ' +
          'including an administrator, and a user with no key simply has no AI features.',
      },
      {
        name: 'AI Tasks',
        description:
          'How this application routes AI by connected-knowledge task. `GET /api/ai-tasks/config` ' +
          'is the capability probe every account can read (`notes:read`): the enabled models, ' +
          'whether **you** have saved a key (`keyConfigured`, the field every AI surface gates on) ' +
          'and the model each task would run on. It replaced `GET /api/ai/config`, which is the ' +
          'platform\'s now. `GET`/`PUT /api/ai-tasks/settings` (`ai_config:read`/`:write`) edit the ' +
          'fields this application adds to the platform `ai` settings namespace: task models, the ' +
          'connected-knowledge switch, the default model and the request limits.',
      },
      {
        name: 'AI Administration',
        description:
          'The deployment-wide AI policy and catalogue (`/api/admin/ai/*`): the kill switch, key ' +
          'policy and provider slots, the model catalogue and which models are enabled, ' +
          'deployment and organization provider keys, and the deployment-wide usage report. Gated ' +
          'on `ai_config:read`/`:write` (system) and `org_ai_config:read`/`:write` (organization), ' +
          'separately from `system_settings:*`. Provider keys are write-only.',
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
    name: 'Transcripts',
    tags: [
      {
        name: 'Transcripts',
        description:
          'Audio in, a diarized and timestamped transcript out. Create a transcript and its ' +
          'resumable upload in one call, watch the pipeline through three independent status ' +
          'fields, read segments and word timings, play the audio through a short-lived signed ' +
          'URL, and retry, cancel or delete. Gated on `transcripts:read`/`transcripts:write`, ' +
          'both seeded to every role including Viewer, because recording a conversation is the ' +
          'action this feature exists for.\n\n' +
          'Per-transcript access is the owner, plus anybody they have shared it with. **No ' +
          'access is a 404, never a 403** — the existence of a specific transcript id is ' +
          'itself something a stranger has no business learning — and there is deliberately ' +
          'no administrator read-any: configuring which provider a deployment uses is not the ' +
          'authority to read what flows through it.',
      },
    ],
  },
  {
    name: 'Notes',
    tags: [
      {
        name: 'Notes',
        description:
          'AI-generated notes, and the sources they are generated from (epic #45). Today this ' +
          'group carries one route: uploading a PDF, plain-text or Markdown **document** to ' +
          'generate a note from. The upload is stored as a storage object owned by the notes ' +
          'module — invisible to `GET /api/storage/objects`, and refusing the generic `DELETE` ' +
          'with a 409 — and a queue job turns it into plain text, because a document outlives ' +
          'the request that uploaded it.\n\n' +
          'Gated on `notes:read`/`notes:write`, both seeded to every role including Viewer, ' +
          'because writing a note from a conversation is the action this epic exists for. A ' +
          'password-protected PDF, a scanned PDF with no text layer, and a corrupt file are all ' +
          'recorded as readable reasons rather than as request failures; optical character ' +
          'recognition is deliberately not supported.',
      },
      {
        name: 'Note Templates',
        description:
          'The object that makes AI notes adaptable without hard-coding every workflow: ' +
          '"produce meeting notes" and "produce a follow-up email" are two **rows**, not two ' +
          'code paths. List, read, create, edit, delete and duplicate your own templates, and ' +
          '**preview** one — saved or unsaved — against a real source before trusting it with a ' +
          'note. Gated on `note_templates:read`/`note_templates:write`, both seeded to every ' +
          'role including Viewer.\n\n' +
          'Every account sees its own templates **plus a set of seeded built-ins**, so a ' +
          'brand-new account opens a full, usable catalogue. Built-ins are readable by everyone ' +
          'and **editable by nobody**: a write against one answers **403** — deliberately ' +
          'unlike the **404** another user\'s template answers, because a built-in is listed in ' +
          'every account\'s own catalogue and hiding a row the caller can already see would ' +
          'mislead rather than protect. Duplicate one to get an editable copy; that is what ' +
          'keeps the seeded set a stable, re-runnable baseline.\n\n' +
          '⚠ A **preview is a real generation on your own provider account** — the same ' +
          '`note.generate` job, prompt assembly, token budget and error taxonomy a real note ' +
          'uses, deliberately, because a second implementation would drift from the real one ' +
          'exactly when it mattered. It creates no template and no note, and expires.',
      },
    ],
  },
  {
    // #354, epic #344; `Ask` appended by #376 (epic #348).
    name: 'Knowledge',
    tags: [
      {
        name: 'Graph',
        description:
          'Your own connected knowledge: the effective ontology, entities, relations, facts ' +
          'with evidence, extraction proposals and their review. Owner-only; no access is ' +
          'always 404, never 403.',
      },
      {
        // #376, epic #348.
        name: 'Ask',
        description: 'Questions answered from your own knowledge graph, with citations. Read-only.',
      },
    ],
  },
  {
    name: 'Search',
    tags: [
      {
        name: 'Search',
        description:
          'Ranked full-text search across the **content** of your transcripts and notes — a ' +
          'word spoken once in the middle of a long recording finds that recording, and a ' +
          'term that appears only in a note body finds that note. Its own group rather than a ' +
          'route inside `Transcripts` or `Notes`, because it is the one surface in this API ' +
          'that spans both and belongs to neither.\n\n' +
          'Results are scored by cover density and rolled up to whole documents by their ' +
          '**best** passage, come with pre-escaped `<mark>`-highlighted snippets, and page ' +
          'through a bounded candidate window with a cursor that is tied to the exact search ' +
          'that produced it. A query made entirely of stopwords degrades to the title match ' +
          'the list endpoints already offer rather than returning nothing, and says so.\n\n' +
          'Gated per document type on the permission that type\'s own controller enforces ' +
          '(`transcripts:read`, `notes:read`), both seeded to every role. Holding only one ' +
          'returns the half you may have rather than a 403; `searchedTypes` reports what was ' +
          'actually searched.',
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
      {
        name: 'Storage Configuration',
        description:
          'The runtime storage provider (driver, bucket, region, endpoint, credentials) an administrator ' +
          'edits in the console, and the connection test that proves a configuration before it is saved.',
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
      {
        name: 'Doctor',
        description:
          'The deployment health report: read-only checks of the identity configuration (JWT secret, ' +
          'sign-in providers, initial administrator, principal cache, tenancy mode). Served by the ' +
          'platform Doctor and gated on `system_settings:read`.',
      },
      {
        name: 'About',
        description:
          'What is deployed here: the deployment record the CLI wrote at deploy time (version, ' +
          'commit, ref, install and update timestamps, host facts, the last remote check), plus ' +
          'the running process\'s own facts and the database\'s. Gated on `system_settings:read` ' +
          '— an administrator\'s configuration read, deliberately not a permission of its own. ' +
          'Read-only, and never makes a network call: "is an update available" is whatever the ' +
          'CLI last recorded.',
      },
      {
        name: 'Telemetry',
        description:
          'Observability for this deployment (the platform telemetry slice): the telemetry policy ' +
          'and the runtime export switch, the GreptimeDB connection and the managed stack, the SQL ' +
          'explorer (query, schema, export), the dashboard with its metric groups and health ' +
          'verdict, and the AI assistant over the data (unavailable until the AI slice is adopted). ' +
          'Gated on `telemetry:read` (settings and status), `telemetry:write` (change them) and ' +
          '`telemetry:query` (SQL, export, dashboard, assistant); the stack routes also need ' +
          '`system_settings:read|write`. `GET /api/telemetry/config` is the signed-in, non-admin ' +
          'probe the client uses to show or hide the telemetry pages.',
      },
    ],
  },
];

for (const group of TAG_GROUPS) {
  for (const tag of group.tags) {
    openApiTags.register({ name: tag.name, description: tag.description, group: group.name });
  }
}

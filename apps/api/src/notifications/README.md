# Adding a Notification

Developer recipe for registering a new notification event (moved here from the root `CLAUDE.md`). Design and rationale live in [`docs/specs/browser-notifications.md`](../../../../docs/specs/browser-notifications.md) and [`docs/specs/notification-broadcasts.md`](../../../../docs/specs/notification-broadcasts.md); the rules for calling `notify()` are in [`AGENTS.md`](../../../../AGENTS.md).

Three steps, and no migration — the same "one registry entry" promise the
settings hub makes on its own axis (epic #109, wired end to end by #128).

1. **Declare the event and its bindings in your module** with a
   `NotificationRegistration` (`registerNotification`, issue #460): the event
   itself (a stable dotted `key` such as `billing.invoice_ready`, a `label` and
   `description` written as user-facing copy, the `channels` it can genuinely
   be delivered over (`email`, `browser`, `push`), and `defaultEnabled`; add
   `mandatory: true` only for events a user must not be able to silence — a
   privilege or security change), plus its `emailTemplate` name and optional
   `browserTemplate`. Put it in `<module>/notifications/<module>.notifications.ts`
   as `<MODULE>_NOTIFICATIONS` (a platform event goes in `BASE_NOTIFICATIONS`,
   `notifications/notification-events.ts`), then **add it to
   `apps/api/src/kvox.manifest.ts`** under `[registry:notifications]` (the
   array order is the order of the `/settings/notifications` matrix). The
   registry validates the registration atomically — key shape, channels,
   `mandatory` implies `defaultEnabled`, and an `emailTemplate` that is already
   registered — and refuses it after bootstrap. This one entry feeds the
   dispatcher, the matrix and the docs; there is no second list to update, and
   no preference row is created for anybody (absent means enabled).

2. **Write the template(s)**, one per channel the event declares.
   - *Email*: a new `<module>/notifications/<name>.email.ts` exporting a
     payload interface and a pure function returning `{ subject, html, text }`.
     Build the body with the `html` tagged literal so every interpolation is
     escaped by construction, pass it to `renderLayout`, put any CTA URL
     through the layout (it applies `safeUrl`), and **hand-write the text
     part** — there is deliberately no HTML-to-text helper. A template may
     opt into the one embedded brand logo by passing `emailLogoAttachment()`'s
     result through as `logo`/`attachments` — see `templates/layout.ts`'s
     header and `templates/brand-logo.ts`. Declare its data type by augmenting
     the base map from the same file —
     `declare module '../../email/templates' { interface EmailTemplateDataMap { 'name': NameEmailData } }`
     — and export the renderer in a record (`<MODULE>_EMAIL_TEMPLATES`) that
     the manifest registers with `registerEmailTemplates` under
     `[registry:email-templates]`, **before** the notifications that bind it.
     A platform template goes in `email/templates/index.ts`
     (`EmailTemplateDataMap` and `BASE_EMAIL_TEMPLATES`). Naming an
     unregistered template in a binding is rejected at start; an event that
     declares `email` with no `emailTemplate` is a recorded delivery failure,
     not a silent skip.
   - *Browser*: the registration's `browserTemplate`, returning
     `{ title, body, link? }`. Optional — a miss falls back to the registry's
     label and description. `link` must be a root-relative path. One renderer
     serves the browser and push channels.
   - The `transcripts/notifications/` and `notes/notifications/` folders and
     `email/templates/role-changed.email.ts` are the worked examples. Specs that
     need a different renderer use `overrideBrowserTemplateForTests`
     (`notification-registry.ts`); the registry itself is not writable.

3. **Call `notify()` at the real trigger**, from a service whose module
   `imports: [NotificationsModule]`:

   ```ts
   await this.notifications.notify('billing.invoice_ready', userId, payload);
   ```

   Place it **after** the triggering write has committed and **outside** any
   `$transaction`. `notify` is detached — it schedules the dispatch and returns
   before anything is rendered or sent — so it never rejects, never joins your
   transaction, and never delays your response; a send failure becomes a
   `notification_deliveries` row, never an exception. Annotate the payload with
   the template's data type: `notify` takes `data: unknown`, so the call site is
   the only place its shape is checked.

   For a recipient who has **no user account** (an allowlist invitation), use
   `notifyAddress(eventKey, email, payload)`. It resolves the address to an
   account when one exists — so real users' preferences are never skipped — and
   otherwise dispatches through the same gate with no stored preferences, which
   the sparse absent-key contract already defines as "use the event's default".

Live examples of all three steps: `AuthService.handleGoogleLogin`
(`user.welcome`), `AllowlistService.addEmail` (`allowlist.invitation`), and
`UsersService.updateUserRoles` (`security.role_changed`, mandatory).

Epic #254's four operational events (`jobs.job_failed`, `nodes.node_offline`,
`db_backup.backup_failed`, `db_backup.restore_completed` — the last one
`mandatory: true`) are worked examples of this same recipe, registered in
`notification-events.ts` (`BASE_NOTIFICATIONS`) beside the ones above; see the events' own
in-file comments and `docs/specs/browser-notifications.md`'s operational-events
section for why no roll-up/digest exists for `jobs.job_failed`.

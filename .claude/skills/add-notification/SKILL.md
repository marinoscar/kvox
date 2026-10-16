---
name: add-notification
description: Add a notification event to the platform notifications slice - write the email template, declare the event with registerNotification, add it to the manifest, and call notify() after the triggering write commits. Use when a feature must tell a user something over email, the in-app bell or Web Push, when adding an event to the preferences matrix, or when editing an existing notification template or event.
---

# Add a notification

Email, notifications, broadcasts and Web Push are the platform's slices: `@marinoscar/platform-api/email`, `@marinoscar/platform-api/notifications` and, on the web, `@marinoscar/platform-web/notifications/{headless,ui}` and `/email/ui`. This repository has no dispatcher, channel, preference, broadcast or push-config code of its own (the old `apps/api/src/notifications` and `apps/api/src/email` folders are gone). It owns three things: **email templates** (`apps/api/src/email-templates/`), **event registrations** (`apps/api/src/notifications-registry/`) and **the call sites**. The contract is the TSDoc in `node_modules/@marinoscar/platform-api/dist/notifications/registry/bindings.registry.d.ts` and `dist/email/templates/`. Design: `docs/specs/browser-notifications.md`, `docs/specs/notification-broadcasts.md`. Architecture: `docs/ARCHITECTURE.md` section 7.9.

No migration and no preference row: the sparse `notifications` user setting treats an absent key as the event's default.

## Steps

1. **Write the email template** (only if the event declares `email`): `apps/api/src/email-templates/<name>.email.ts`, a pure function returning `{ subject, html, text }`.
   ```ts
   import { html, renderLayout, safeUrl, type EmailTemplate } from '@marinoscar/platform-api/email';
   ```
   Build the body with the `html` tag so every interpolation is escaped, pass it to `renderLayout`, and put any link through `safeUrl`. Hand-write the `text` part; there is no HTML-to-text helper. Declare the data type next to the template:
   ```ts
   declare module '@marinoscar/platform-api/email' {
     interface EmailTemplateDataMap { 'name': NameEmailData }
   }
   ```
   Add the renderer to `KVOX_EMAIL_TEMPLATES` in `email-templates/index.ts`. A template the platform already ships (`user-welcome`, `allowlist-invitation`, `role-changed`, `broadcast`, `job-failed`, `node-offline`, `backup-failed`, `restore-completed`, `test-email`) is not rewritten here; bind the event to it by name. The embedded brand logo is the layout's brand mark (`email-templates/brand-logo.ts`, configured in `platform/email/email.options.ts`); a template does not attach it itself. A template name is persisted in deliveries: never rename one.
2. **Declare the event** in `apps/api/src/notifications-registry/<domain>.notifications.ts` as an entry of `<DOMAIN>_NOTIFICATIONS`, typed `NotificationRegistration`:
   - `event`: a stable dotted lowercase `key` (`billing.invoice_ready`), a user-facing `label` and `description`, the `channels` it can genuinely use (`email`, `browser`, `push`), `defaultEnabled`, and `mandatory: true` only for events a user must not silence (a privilege or security change; `mandatory` implies `defaultEnabled`).
   - `emailTemplate`: the template name from step 1. An event that declares `email` with no template is a recorded delivery failure.
   - `browserTemplate`: optional pure `(data) => { title, body, link? }`; it serves the bell row and the push toast. `link` is a root-relative path. A miss falls back to the label and description.
3. **Add the array to the manifest**: `registerNotifications([...])` in `apps/api/src/platform/notifications/notification.manifest.ts`. Order is fixed: platform channels, `configureEmailRendering`, platform email templates, `registerEmailTemplates(KVOX_EMAIL_TEMPLATES)`, then the notifications. Array order is the order of the `/settings/notifications` matrix. The registry validates atomically (key shape, channels, template exists) and freezes after bootstrap; a second registration of one key throws at import.
4. **Call `notify()` at the real trigger**, from a service that injects the platform `NotificationsService` (`@marinoscar/platform-api/notifications`; the slice is a global mount, so the service's module imports nothing):
   ```ts
   await this.notifications.notify('billing.invoice_ready', userId, payload satisfies NameEmailData);
   ```
   Place it **after** the triggering write has committed and **outside** any `$transaction`. `notify` is detached and never rejects; a send failure becomes a `notification_deliveries` row. The payload is `unknown` to `notify`, so annotate it with the template's data type. Other entry points: `notifyAddress(eventKey, email, data)` for a recipient with no account (it resolves to an account when one exists, so preferences still apply), `notifyPermissionHolders(eventKey, permission, data)` for an operational audience, and `notifyNow` when the caller needs the outcome (a broadcast test send).
5. **Tests.** Add the event to `apps/api/test/notifications/kvox-events.spec.ts` (key, channels, `mandatory`, template) and a snapshot spec beside the template (`email-templates/<name>.email.spec.ts`). The `notifications` and `email` conformance suites (`apps/api/test/conformance.spec.ts`) include `after-commit`, `templates`, `channel-templates` and `no-secret`; `afterCommitAllowlist` stays empty.

## Rules

- Event keys, channel ids and template names are persisted (preferences, deliveries). Never rename one; a rename is a new event.
- A notification is never a long-running job. Do not render or send inline in a handler; `notify` schedules the dispatch.
- Do not register `registerAndroidAppNotificationChannel`; this app has no Android client.
- The operational and broadcast events (`jobs.job_failed`, `nodes.node_offline`, `admin.broadcast`, `admin.broadcast_critical`) come from the platform's own arrays (`OPS_NOTIFICATIONS`, `NODES_NOTIFICATIONS`, `BROADCASTS_NOTIFICATIONS`), registered in the manifest as they are. Never redeclare one.
- The service worker never calls the API and `sw.js` stays `no-cache` (`apps/web/src/sw.ts`, composed from `registerNotificationServiceWorkerHandlers`; local exceptions in `docs/platform-adoption/local-exceptions.md`).

## Verify

```bash
cd apps/api && npm run typecheck && node scripts/jest.js --config ./test/jest.config.js --runTestsByPath test/notifications/kvox-events.spec.ts test/conformance.spec.ts -i
```

Flag the new event for the docs agent (event table in `docs/specs/browser-notifications.md`).

---
name: add-settings-page
description: Add an admin or per-user settings page to the web app as a registry card - the entry in adminSections.tsx or userSettingsSections.tsx, the exact permission string the API controller enforces, reuse of SettingsHub, the route, and the registry tests. Use when adding any new settings screen, admin Console page or per-user preference page.
---

# Add a settings page

Rationale and accessibility: `docs/specs/settings-ui.md` (`grep -n '^#' <file>`, read the section you need). Run web checks from `apps/web`.

## Steps

1. Write the page component. Gate writes inside the page (disabled controls), not with a second card permission. Hide controls with `usePermissions` (`apps/web/src/hooks/usePermissions.ts`); the API enforces.
2. Add ONE card to the registry, appended to the end of its section or a new section (never inserted between existing cards):
   - admin: `ADMIN_SECTIONS` in `apps/web/src/config/adminSections.tsx`
   - per-user: `USER_SETTINGS_SECTIONS` in `apps/web/src/config/userSettingsSections.tsx`
   A card is `SettingsCardDef` (`adminSections.tsx`, `export interface SettingsCardDef`): `{ title, description, Icon, path?, disabled?, permission?, alwaysShow? }`. `Icon` is a component, never a rendered element.
3. Add the route in `apps/web/src/App.tsx` beside the other `/admin/settings/*` (or `/settings/*`) routes. A route without a registry entry is unacceptable: the hub, the Console rail and the AppBar title resolver would not know it.
4. Add API calls through `apps/web/src/services/api.ts` wrapped in a hook.

## Rules

- A new page is a card, never a tab on an existing settings page. Tabs are only for parallel content inside one destination (`apps/web/src/pages/Admin/UsersPage.tsx`: Users, Allowlist).
- `permission` is the exact string the controller's `@Auth(...)` enforces; read it off the controller. Never invent one or approximate it. Verified in `adminSections.tsx` today:
  - `system_settings:read` (Setup, Email, Notifications, Transcription, AI, Maintenance, About; `system-settings.controller.ts`, `about.controller.ts`)
  - `users:read`, `push:read`, `jobs:read`, `nodes:read`, `db_backup:read`, `broadcasts:read`
  - `allowlist:read` gates content inside the Users page, not a card.
  Per-user cards carry no `permission` (the API routes are ownership-scoped `@Auth()`); the one exception is `graph:write` on the Knowledge graph card.
- Reuse `SettingsHub` (`apps/web/src/components/settings/SettingsHub.tsx`). A new hub is a 4-prop binding (`sections`, `hubKey`, `title`, `subtitle`); never fork it. `/settings` is `apps/web/src/pages/UserSettingsHubPage.tsx`.
- Never call a provider from the browser; AI goes through `/api/*`.
- The five breakpoint gates (`components/common/Layout.tsx` `showRail` and `<main>` `pb`, `BottomNav`, `AppBar.tsx` and `SettingsHub.tsx` `isCompactWindow`, all at `sm` 600px) move together or not at all. Do not touch them for a normal page.
- Runtime-configured features (storage, AI, Web Push, SMTP) never get environment variables.

## Verify

```bash
cd apps/web && npm run typecheck && npm run test:run
```

The registry suites must pass: `apps/web/src/__tests__/config/settingsRegistry.test.ts` and `userSettingsSections.test.ts`. Add component and hook tests with MSW. Check phone width and desktop width. Flag the card for the docs agent (settings-page inventory in `docs/ARCHITECTURE.md` and `CLAUDE.md`).

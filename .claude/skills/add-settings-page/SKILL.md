---
name: add-settings-page
description: Add an admin or per-user settings page to the kvox web app as a registry card - the entry in adminSections.tsx or userSettingsSections.tsx, the exact permission string the API controller enforces, reuse of SettingsHub, the route, and the registry tests. Use when adding any new settings screen, admin Console page or per-user preference page.
---

# Add a settings page

Rationale and accessibility: `docs/specs/settings-ui.md` (`grep -n '^#' <file>`, read the section you need). Run web checks from `apps/web`.

## Steps

1. Write the page component. Gate writes inside the page (disabled controls), not with a second card permission. The API enforces; the UI only hides.
2. Add ONE card to the registry, appended after existing cards in its group (never inserted between):
   - admin: `ADMIN_SECTIONS` in `apps/web/src/config/adminSections.tsx`
   - per-user: `USER_SETTINGS_SECTIONS` in `apps/web/src/config/userSettingsSections.tsx`
   A card is a `SettingsCardDef` (declared in `adminSections.tsx`): `{ title, description, Icon, path?, disabled?, permission?, alwaysShow? }`. `Icon` is a component, never a rendered element.
3. Add the route in `apps/web/src/App.tsx` beside the other `/admin/settings/*` (or `/settings/*`) routes. A route without a registry entry is unacceptable: the hub, the Console rail and the AppBar title resolver would not know it.
4. Add API calls through `apps/web/src/services/api.ts`, wrapped in a hook.

## Rules

- A new page is a card, never a tab on an existing settings page. Tabs are only for parallel content inside one destination; the live example is `apps/web/src/pages/Admin/UsersPage.tsx` (Users, Allowlist).
- `permission` is the exact string the API controller enforces; read it off the controller, never invent or approximate it. Known: `system_settings:read`/`write` (`apps/api/src/settings/system-settings/system-settings.controller.ts`), `users:read`, `allowlist:read` (gates content inside the Users page, not the route), `jobs:read`, `nodes:read`, `db_backup:read`, `broadcasts:read`, `push:read`. The About card reuses `system_settings:read` on purpose.
- Reuse `apps/web/src/components/settings/SettingsHub.tsx`. A new hub is a 4-prop binding (`sections`, `hubKey`, `title`, `subtitle`); never fork or copy it. The worked example is `apps/web/src/pages/UserSettingsHubPage.tsx`.
- The five breakpoint gates (`Layout.tsx` `showRail` and `<main>` `pb`, `BottomNav`, `SettingsHub` and `AppBar` `isCompactWindow`, all at `sm` 600px) move together or not at all. Do not touch them for a normal page.
- Never put an AI provider key or call a provider from the browser; AI goes through the API.

## Verify

```bash
cd apps/web && npm run typecheck && npm run test:run
```

The registry suites must pass: `apps/web/src/__tests__/config/settingsRegistry.test.ts` and `apps/web/src/__tests__/config/userSettingsSections.test.ts`; add a card-specific test beside them when the card has special gating. Add component and hook tests. Check phone width and desktop width. Flag the card for the docs agent (settings inventory in `docs/specs/settings-ui.md`).

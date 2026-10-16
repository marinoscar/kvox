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
   A card is a `SettingsCardDef` (declared in `adminSections.tsx`): `{ title, description, Icon, path?, disabled?, permission?, feature?, alwaysShow? }`. `Icon` is a component, never a rendered element. `feature` (`'ai'`, `'graph'`, `'telemetry'`; resolved in `apps/web/src/config/settingsFeatures.ts`) hides the card while that deployment feature is off; the card that switches a feature on must carry none (the admin `AI` card).
3. Add the route in `apps/web/src/App.tsx` beside the other `/admin/settings/*` (or `/settings/*`) routes. A route without a registry entry is unacceptable: the hub, the Console rail and the AppBar title resolver would not know it.
4. Add API calls through `apps/web/src/services/api.ts`, wrapped in a hook.

## Rules

- A new page is a card, never a tab on an existing settings page. Tabs are only for parallel content inside one destination; the live example is `apps/web/src/identity/UsersPage.tsx` (the packaged Users and Allowlist page plus KVox's Reminders tab). Application-specific content that rides on a platform page goes in that page's slots (`Sections` on the platform `AiConfigPage`: `apps/web/src/pages/Admin/AiSettingsPage.tsx`), never as a tab or a second card.
- `permission` is the exact string the API controller enforces; read it off the controller, never invent or approximate it. Known: `system_settings:read`/`write` (`apps/api/src/settings/system-settings/system-settings.controller.ts`), `users:read`, `allowlist:read` (gates content inside the Users page, not the route), `jobs:read`, `nodes:read`, `db_backup:read`, `broadcasts:read`, `push:read`, `storage_config:read`, `ai_config:read` (admin `AI`, `AI models`, `AI usage`), `ai:use` (user `AI Provider`). The About card reuses `system_settings:read` on purpose. When the page is a platform page (AI, storage, identity), the platform controller names the permission; read it from the installed package, not from memory.
- Reuse the packaged `SettingsHub` (`@marinoscar/platform-web/settings/ui`); the app keeps no copy. A new hub is a 4-prop binding (`sections`, `hubKey`, `title`, `subtitle`); never fork or copy it. The worked example is `apps/web/src/pages/UserSettingsHubPage.tsx`.
- The five breakpoint gates (`Layout.tsx` `showRail` and `<main>` `pb`, `BottomNav`, `SettingsHub` and `AppBar` `isCompactWindow`, all at `sm` 600px) move together or not at all. Do not touch them for a normal page.
- Never put an AI provider key or call a provider from the browser; AI goes through the API. The AI pages (`AI`, `AI models`, `AI usage`, `AI Provider`) are the platform's (`@marinoscar/platform-web/ai/ui`), and a new AI-related setting of this application is a section in `AiConfigPage`'s `Sections` slot talking to `/api/ai-tasks/*`.

## Verify

```bash
cd apps/web && npm run typecheck && npm run test:run
```

The registry suites must pass: `apps/web/src/__tests__/config/settingsRegistry.test.ts` and `apps/web/src/__tests__/config/userSettingsSections.test.ts`; add a card-specific test beside them when the card has special gating. Add component and hook tests. Check phone width and desktop width. Flag the card for the docs agent (settings inventory in `docs/specs/settings-ui.md`). A card with a new `permission` string also needs it in `DEFAULT_PERMISSIONS` of `apps/web/visual/main.tsx`.

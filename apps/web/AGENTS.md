# apps/web rules

Root rules ([AGENTS.md](../../AGENTS.md)) apply. This file is what to get right when editing the React app. Spec: [docs/specs/settings-ui.md](../../docs/specs/settings-ui.md); destinations: [docs/specs/ux-refresh.md](../../docs/specs/ux-refresh.md) §1.

## Layout

- `src/config/`: `adminSections.tsx` (`ADMIN_SECTIONS`, `SettingsCardDef`), `userSettingsSections.tsx` (`USER_SETTINGS_SECTIONS`), `destinations.ts` (the navigation table), `shell.ts` (`KVOX_NAVIGATION`).
- `src/pages/`, `src/components/` (`settings/` holds only KVox's own cards, `common/Layout.tsx` the thin `KvoxAppShell` binding, `library/`), `src/hooks/`, `src/services/api.ts` (the `PlatformHttpClient` instance and KVox's endpoint functions), `src/contexts/`, `src/platform/` (bindings of packaged slices), `src/platform-kvox/` (binds `@marinoscar/kvox-web`: `KvoxHostBinding.tsx` builds the one `KvoxWebHost` over `api`). Domain slices move into `@marinoscar/kvox-web`; the app spreads their cards and routes where its literal entries were. The shell (rail, bar, AppBar, user menu, `renderKvoxRoutes`) is `@marinoscar/kvox-web/shell`.
- `src/identity/`: KVox's bindings of the platform identity slice (`@marinoscar/platform-web/identity/{headless,ui}`): `IdentityProviders.tsx` (`AuthProvider` with `client={api}` and the push-unsubscribe `onBeforeLogout`), `identityAdapters.ts`, `LoginPage.tsx` (brand mark in the `Logo` slot), `UsersPage.tsx` + `usersPageSlots.ts` (Reminders tab). `useAuth`, `usePermissions`, `RequireAuth`, `RequirePermission` come from `@marinoscar/platform-web/identity/headless`.
- Routes live in `src/App.tsx`. Tests: `src/__tests__/` (Vitest + React Testing Library, MSW for the API); registry suites in `src/__tests__/config/` (`settingsRegistry.test.ts`, `userSettingsSections.test.ts`, `destinations.test.ts`).

## Settings UI Pattern (rules 1 to 5 in root AGENTS.md)

1. A new settings page is a card appended to `ADMIN_SECTIONS` or `USER_SETTINGS_SECTIONS`, plus its route in `App.tsx`. No route without a card.
2. Never add a settings page as a tab of another. Tabs only for parallel content inside one destination (live example: the packaged Users & Allowlist page, `@marinoscar/platform-web/identity/ui` `UsersPage`, with KVox's Reminders tab appended through `slots.Tabs` in `src/identity/usersPageSlots.ts`).
3. A card's `permission` is the exact string the API controller enforces (e.g. `system_settings:read`, `users:read`, `jobs:read`, `ai:use`). A card may also declare `feature: 'ai'` (hidden while AI is off; the admin `AI` card is the switch and carries none), resolved in `src/config/settingsFeatures.ts`. Writes are gated inside the page by disabling controls.
4. Reuse the packaged `SettingsHub` (`@marinoscar/platform-web/settings/ui`); never fork it or add a local copy. Profile, Appearance and the `useSystemSettings`/`useUserSettings` hooks are the platform's. `src/pages/UserSettingsHubPage.tsx` is the 4-prop binding.
5. Update the registry tests above when you add a card.

## Five coupled breakpoint gates

Change all five together or none; the boundary is `sm` (600px), never `md`. Since #484 all five are the package's: `ShellLayout` `showRail` (`up('sm')`) and `<main>` `pb: { xs: 10, sm: 3 }`, `ShellBottomNav` and `ShellAppBar` `down('sm')` (`@marinoscar/platform-web/shell/ui`), `SettingsHub` `isCompactWindow` (`settings/ui`). `Layout.tsx` and the shell binding read no breakpoint; `src/__tests__/config/breakpointGates.test.ts` fails on any `useMediaQuery(` or `breakpoints.up|down(` not listed with a reason. `LibraryPageFrame` (in `@marinoscar/kvox-web/core/ui`) also reads `down('sm')` but is **not** a sixth gate: it only places one page's create action. The rail's collapsed width (the package's 56px) is a width, not a gate.

## Navigation destinations

`src/config/destinations.ts` is the single source for the bottom bar, the rail and the avatar menu (a `ShellDestination` table; `config/shell.ts` binds it into `KVOX_NAVIGATION`). Six destinations: `home`, `transcripts`, `notes`, `knowledge`, `settings`, `console`. Full model: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

- Each non-pinned destination gates on the exact permission its controller enforces.
- **`pinned` means a MODE, not a peer**: at the rail's foot and in the avatar menu, not on the bottom bar. `settings` and `console` are pinned. The package's bar would draw them plus a "More" tab, so `KvoxAppShell` gives the bar `withoutPinned(KVOX_NAVIGATION)` (non-pinned only), never `KVOX_NAVIGATION`. Shell glue is `@marinoscar/kvox-web/shell`.
- **Four bottom-bar tabs is the ceiling** (`BOTTOM_BAR_DESTINATIONS = DESTINATIONS.filter((d) => !d.pinned)`). A fifth non-pinned destination is a redesign of the bar, not an addition.
- `knowledge` (`/graph`, `/ask`) gates on `graph:read` **and** `feature: 'graph'` (`config/settingsFeatures.ts`, fed by `GET /api/ai-tasks/config`'s `graphEnabled` through `platform/GraphFeatureBinding.tsx`); while unknown or loading the item is hidden, never shown then removed.
- Graph drawing goes through `GraphCanvas.tsx`, the one file that imports sigma.

## Frontend conventions

- Brand lives in `kvox-web/brand`.
- The UI presents; the API authorizes. Hiding a card or button is not security.
- Use MUI theming and the responsive shell; write components and hooks with tests.
- Never call an AI provider from the browser; go through `/api`.
- The AI pages (AI, AI models, AI usage, AI Provider) are the platform's (`@marinoscar/platform-web/ai/ui`); the app's own task-model, graph and ceiling sections ride in `AiConfigPage`'s `Sections` slot (`src/pages/Admin/AiSettingsPage.tsx`, `src/components/admin/AiTasksSettingsSections.tsx`) and talk to `/api/ai-tasks/*` through `src/services/aiTasks.ts`.
- Runtime-configured features (transcription, AI, VAPID, SMTP) are admin-UI settings, never build-time variables.

Run: `npm run test:run --workspace=web`, `npm run typecheck --workspace=web`.

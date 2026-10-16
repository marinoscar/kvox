# apps/web rules

Root rules ([AGENTS.md](../../AGENTS.md)) apply. This file is what to get right when editing the React app. Spec: [docs/specs/settings-ui.md](../../docs/specs/settings-ui.md); destinations: [docs/specs/ux-refresh.md](../../docs/specs/ux-refresh.md) §1.

## Layout

- `src/config/`: `adminSections.tsx` (`ADMIN_SECTIONS`, `SettingsCardDef`), `userSettingsSections.tsx` (`USER_SETTINGS_SECTIONS`), `destinations.ts`.
- `src/pages/`, `src/components/` (`settings/` holds only KVox's own cards, `navigation/`, `common/Layout.tsx`, `library/`), `src/hooks/`, `src/services/api.ts` (the `PlatformHttpClient` instance and KVox's endpoint functions), `src/contexts/`.
- `src/identity/`: KVox's bindings of the platform identity slice (`@marinoscar/platform-web/identity/{headless,ui}`): `IdentityProviders.tsx` (`AuthProvider` with `client={api}` and the push-unsubscribe `onBeforeLogout`), `identityAdapters.ts`, `LoginPage.tsx` (brand mark in the `Logo` slot), `UsersPage.tsx` + `usersPageSlots.ts` (Reminders tab). `useAuth`, `usePermissions`, `RequireAuth` and `RequirePermission` are imported from `@marinoscar/platform-web/identity/headless`; KVox has no `AuthContext` of its own.
- Routes live in `src/App.tsx`. Tests: `src/__tests__/` (Vitest + React Testing Library, MSW for the API); registry suites in `src/__tests__/config/` (`settingsRegistry.test.ts`, `userSettingsSections.test.ts`, `destinations.test.ts`).

## Settings UI Pattern (rules 1 to 5 in root AGENTS.md)

1. A new settings page is a card appended to `ADMIN_SECTIONS` or `USER_SETTINGS_SECTIONS`, plus its route in `App.tsx`. No route without a card.
2. Never add a settings page as a tab of another. Tabs only for parallel content inside one destination (live example: the packaged Users & Allowlist page, `@marinoscar/platform-web/identity/ui` `UsersPage`, with KVox's Reminders tab appended through `slots.Tabs` in `src/identity/usersPageSlots.ts`).
3. A card's `permission` is the exact string the API controller enforces (`system_settings:read`, `users:read`, `allowlist:read`, `jobs:read`, `nodes:read`, `db_backup:read`, `broadcasts:read`, `push:read`, `storage_config:read`). Writes are gated inside the page by disabling controls.
4. Reuse the packaged `SettingsHub` (`@marinoscar/platform-web/settings/ui`); never fork it or add a local copy. Profile and Appearance are the packaged `UserProfilePage` and `UserAppearancePage` from the same entry; the `useSystemSettings` and `useUserSettings` hooks come from `@marinoscar/platform-web/settings/headless`. `src/pages/UserSettingsHubPage.tsx` is the 4-prop binding.
5. Update the registry tests above when you add a card.

## Five coupled breakpoint gates

Change all five together or none. The boundary is `sm` (600px), never `md` (900px). No shared constant binds them.

| # | Gate | File (under `src/`) |
|---|---|---|
| 1 | `Layout.tsx` `showRail` (`up('sm')`) mounts `NavigationRail` | `components/common/Layout.tsx` |
| 2 | `BottomNav` self-gate `down('sm')` | `components/navigation/BottomNav.tsx` |
| 3 | `<main>` `pb: { xs: 10, sm: 3 }` | `components/common/Layout.tsx` |
| 4 | `SettingsHub` `isCompactWindow` (`down('sm')`) | `@marinoscar/platform-web/settings/ui` (the package keeps the gate; not a file in `src/`) |
| 5 | `AppBar` `isCompactWindow` (`down('sm')`) | `components/navigation/AppBar.tsx` |

`components/library/LibraryPageFrame.tsx` also reads `down('sm')` but is **not** a sixth gate: it only decides where one page puts its create action (header button or FAB), never whether app chrome mounts. The rail's collapsed width (72px) is a width, not a gate.

## Navigation destinations

`src/config/destinations.ts` is the single source for the bottom bar, the rail and the avatar menu. Six destinations: `home`, `transcripts`, `notes`, `knowledge`, `settings`, `console`. Full model: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

- Each non-pinned destination gates on the exact permission its controller enforces.
- **`pinned` means a MODE, not a peer**: rendered at the rail's foot, in the avatar menu, omitted from the bottom bar. `settings` and `console` are pinned.
- **Four bottom-bar tabs is the ceiling** (`BOTTOM_BAR_DESTINATIONS = DESTINATIONS.filter((d) => !d.pinned)`). A fifth non-pinned destination is a redesign of the bar, not an addition.
- `knowledge` (`/graph`, `/ask`) gates on `graph:read` **and** `GET /api/ai/config`'s `graphEnabled`; while that flag is unknown or loading the item is hidden, never shown then removed.
- Graph drawing goes through `GraphCanvas.tsx`, the one file that imports sigma.

## Frontend conventions

- The UI presents; the API authorizes. Hiding a card or button is not security.
- Use MUI theming and the responsive shell; write components and hooks with tests.
- Never call an AI provider from the browser; go through `/api`.
- Runtime-configured features (transcription, AI, VAPID, SMTP) are admin-UI settings, never build-time variables.

Run: `npm run test:run --workspace=web`, `npm run typecheck --workspace=web`.

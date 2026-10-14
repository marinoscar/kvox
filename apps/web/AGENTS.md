# apps/web rules

Root rules ([AGENTS.md](../../AGENTS.md)) apply. This file is what to get right when editing the React app. Spec: [docs/specs/settings-ui.md](../../docs/specs/settings-ui.md).

## Layout

- `src/config/`: `adminSections.tsx`, `userSettingsSections.tsx`, `destinations.ts`.
- `src/pages/` (`Admin/`, `UserSettingsHubPage.tsx`), `src/components/` (`common/`, `navigation/`, `settings/`, `library/`), `src/hooks/`, `src/contexts/`, `src/services/`.
- Tests: `src/__tests__/` (Vitest + RTL, MSW handlers in `src/__tests__/mocks/`).

## Settings UI

1. A new settings page is a card in `apps/web/src/config/adminSections.tsx` (`SettingsCardDef`, `ADMIN_SECTIONS`) or `userSettingsSections.tsx` (`USER_SETTINGS_SECTIONS`), plus its route. No route without a card.
2. Never add a settings page as a tab of another. Tabs only for parallel content inside one destination (example: Users / Allowlist in `src/pages/Admin/UsersPage.tsx`). Destination gate = reachability; tab gate = content.
3. A card's `permission` is the exact string the API controller enforces. Writes are gated inside the page by disabling controls.
4. Reuse `src/components/settings/SettingsHub.tsx`; never fork it. `src/pages/UserSettingsHubPage.tsx` is the 4-prop binding (`sections`, `hubKey`, `title`, `subtitle`).

## Five coupled breakpoint gates

Change all five together or none. The boundary is `sm` (600px), never `md` (900px). No shared constant binds them ([why](../../docs/specs/settings-ui.md)).

| # | Gate | File |
|---|---|---|
| 1 | `showRail` (`up('sm')`) mounts `NavigationRail` | `src/components/common/Layout.tsx` |
| 2 | `BottomNav` self-gate `down('sm')` | `src/components/navigation/BottomNav.tsx` |
| 3 | `<main>` `pb: { xs: 10, sm: 3 }` | `src/components/common/Layout.tsx` |
| 4 | `isCompactWindow` (`down('sm')`) | `src/components/settings/SettingsHub.tsx` |
| 5 | `isCompactWindow` (`down('sm')`) | `src/components/navigation/AppBar.tsx` |

Still exactly five. `src/components/library/LibraryPageFrame.tsx` also reads `down('sm')` but only places one page's create action (header button or FAB); it never mounts chrome, so it is not a sixth gate. The rail's collapsed width moving 56 to 72px is a width, not a gate.

## Navigation destinations

`src/config/destinations.ts` is the single source for the bottom bar, rail and avatar menu ([design](../../docs/ARCHITECTURE.md#96-navigation-destinations), [ux-refresh](../../docs/specs/ux-refresh.md)).

- Six destinations: `home`, `transcripts`, `notes`, `knowledge`, `settings`, `console`. Each non-pinned one gates on the exact permission its controller enforces.
- `pinned` means a MODE, not a peer: rail foot, avatar menu, omitted from the bottom bar (`settings`, `console`).
- Four bottom-bar tabs is the ceiling. A fifth non-pinned destination is a redesign of the bar, not an addition.
- `knowledge` (path `/graph`, also owns `/ask`) gates on `graph:read` AND `GET /api/ai/config` `graphEnabled`. It is hidden while that flag is unknown or loading, so it never flashes in and out.
- Registry tests to update with any change: `src/__tests__/config/settingsRegistry.test.ts`, `userSettingsSections.test.ts`, `destinations.test.ts`.

## Conventions

- The UI presents; the API authorizes. Hiding a card or button is not security.
- All HTTP goes through `src/services/api.ts`; never call an AI provider from the browser, use `/api/ai/*`.
- Use MUI theming and the responsive shell; components and hooks ship with tests.

Run: `npm run test:run --workspace=web`, `npm run typecheck --workspace=web`.

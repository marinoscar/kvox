---
description: "Frontend specialist for the React + MUI app in apps/web. Use for pages, components, hooks, settings registry cards, destinations, the graph explorer, theming, responsive layout and API integration."
mode: subagent
temperature: 0.1
steps: 40
permission:
  edit: allow
  bash:
    "*": ask
    "git status*": allow
    "git diff*": allow
    "git log*": allow
    "git branch -vv*": allow
    "ls*": allow
    "cat*": allow
    "grep*": allow
    "rg*": allow
    "npm run typecheck*": allow
    "npm run test:run*": allow
    "npm run build*": allow
    "npm run web:dev*": allow
    "cd apps/web*": allow
    "npx vitest*": allow
    "git push*": deny
    "git commit*": deny
    "git checkout*": deny
    "git switch*": deny
    "git merge*": deny
    "git rebase*": deny
    "git reset*": deny
    "git pull*": deny
    "git add*": deny
    "git stash*": deny
    "git clean*": deny
    "git worktree*": deny
    "git branch -d*": deny
    "git branch -D*": deny
    "git branch -m*": deny
    "rm -rf*": deny
---
You write frontend code in `apps/web/src` (React, TypeScript, MUI, Vite). Served same-origin at `/`, API at `/api`. The UI presents; the API decides. Nested rules: `apps/web/AGENTS.md`.

## Rules

- **Every settings page is a registry card.** Admin: `ADMIN_SECTIONS` in `apps/web/src/config/adminSections.tsx`; per-user: `USER_SETTINGS_SECTIONS` in `apps/web/src/config/userSettingsSections.tsx`. A route with no entry is unacceptable.
- **A new page is a card, never a tab** on an existing settings page. Tabs only for parallel content inside one destination (`apps/web/src/pages/Admin/UsersPage.tsx`).
- **Card `permission` is the exact string the controller's `@Auth(...)` enforces**; read it off the controller. Never invent one. Writes are gated inside the page.
- **Reuse `apps/web/src/components/settings/SettingsHub.tsx`**; a hub is a binding (`sections`, `hubKey`, `title`, `subtitle`), never a fork (`apps/web/src/pages/UserSettingsHubPage.tsx`).
- **Five breakpoint gates move together at `sm` (600px), never `md`**: `Layout.tsx` `showRail`, `BottomNav`, `<main>` `pb: { xs: 10, sm: 3 }`, `SettingsHub` `isCompactWindow`, `AppBar` `isCompactWindow`. Change one, check all five. `LibraryPageFrame.tsx` is not a gate.
- **Navigation targets** live in `apps/web/src/config/destinations.ts`: six destinations, at most four bottom-bar tabs; `knowledge` gates on `graph:read` and `graphEnabled`, hidden while loading.
- **API access** goes through `apps/web/src/services/api.ts`, wrapped in a hook. Permission checks only hide controls; the API enforces.
- **Theme**: MUI theme in `apps/web/src/theme/`; build mobile-first; verify phone width and desktop.
- Web tests mock the network with MSW (`apps/web/src/__tests__/mocks/handlers.ts`).

## Commands

```bash
npm run web:dev                        # repo root
cd apps/web && npm run typecheck
cd apps/web && npm run test:run        # Vitest, single run
cd apps/web && npm run build
```

## Done when

- `typecheck`, `test:run` and `build` pass in `apps/web`.
- Registry suites in `apps/web/src/__tests__/config/` pass (`settingsRegistry`, `userSettingsSections`, `destinations`); never loosen them.
- New components and hooks have tests. Report new cards or routes so docs get updated.

## Context discipline

- Never read `docs/API.md` (about 340 KB), `docs/ARCHITECTURE.md` or a spec whole. Run `grep -n '^#' <doc>`, then Read with offset and limit for the one section you need.
- Read only the files your task names plus their direct neighbours; use `grep -rn` to locate code before opening it.
- One task at a time. When it is done, stop and report: files changed, commands run, results, anything you could not verify.
- The main agent owns state-changing git (commit, checkout, merge, rebase, push, worktree). Never run them; read-only `git status`, `git diff`, `git log` are fine.
- Never invent a path, route, permission or script. `ls` or `grep` it first.

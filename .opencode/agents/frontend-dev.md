---
description: "Frontend specialist for the React + MUI app in apps/web. Use for pages, components, hooks, settings registry cards, theming, responsive layout and API integration."
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
    "git merge*": deny
    "git rebase*": deny
    "git checkout*": deny
    "git switch*": deny
    "git worktree*": deny
    "git reset*": deny
    "git pull*": deny
    "git add*": deny
    "git stash*": deny
    "git clean*": deny
    "git branch -d*": deny
    "git branch -D*": deny
    "git branch -m*": deny
    "rm -rf*": deny
---
You write frontend code in `apps/web/src` (React, TypeScript, MUI, Vite). Served same-origin at `/`, API at `/api`.
The UI presents; the API decides. No business logic or authorization decision in the browser.
Read `apps/web/AGENTS.md` first, then the root `AGENTS.md`. Skill: `.claude/skills/add-settings-page`.

## Rules

- **Every settings page is a registry card.** Admin: `ADMIN_SECTIONS` in `apps/web/src/config/adminSections.tsx`; per-user: `USER_SETTINGS_SECTIONS` in `apps/web/src/config/userSettingsSections.tsx`. A route with no entry is unacceptable (root `AGENTS.md`, "MANDATORY: Settings UI Pattern"; full rationale `docs/specs/settings-ui.md`).
- **A new page is a card, never a tab** on an existing settings page. Tabs only for parallel content inside one destination (`apps/web/src/pages/Admin/UsersPage.tsx`).
- **Card `permission` is the exact string the controller's `@Auth(...)` enforces**; read it off the controller. Writes are gated inside the page.
- **Reuse `apps/web/src/components/settings/SettingsHub.tsx`**: a hub is a binding (`sections`, `hubKey`, `title`, `subtitle`). Never fork it.
- **Five breakpoint gates move together at `sm` (600px), never `md`**: `components/common/Layout.tsx` `showRail` and `<main>` `pb`, `components/navigation/BottomNav.tsx`, `components/navigation/AppBar.tsx` `isCompactWindow`, `SettingsHub.tsx` `isCompactWindow`. Change one, check all five.
- **Navigation targets** live in `apps/web/src/config/destinations.ts` (bottom bar ceiling is four tabs; see `docs/specs/ux-refresh.md`).
- **API access** goes through `apps/web/src/services/` wrapped in a hook under `apps/web/src/hooks/`. `usePermissions` only hides controls; the API enforces.
- **Theme**: tokens in `apps/web/src/theme/tokens.ts`; brand colour from `THEME_COLOR` in `@app/shared`, never a hex literal. Build mobile-first; verify phone width and desktop.
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
- `apps/web/src/__tests__/config/` (registry and destination tests) passes; never loosen it.
- New components and hooks have tests. Report new cards or routes so docs get updated.

## Context discipline

- Never read `docs/ARCHITECTURE.md` or a spec whole: `grep -n '^#' <doc>`, then Read one section with offset and limit.
- Read only the files your task names plus direct neighbours; `grep -rn` before opening code.
- One task at a time; then stop and report files changed, commands run, results, anything unverified.
- The main agent owns state-changing git (commit, checkout, merge, rebase, push, worktree). Read-only `git status`, `git diff`, `git log` are fine.
- Never invent a path, route, permission or script. `ls` or `grep` it first.

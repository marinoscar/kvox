# shell

The KVox app shell, once: the navigation, the route renderer, the default links, the "add your AI key" state and the shell component that web and KVox Desktop both render.

## Purpose and scope

KVox web and KVox Desktop show the same features through the same chrome by rendering this slice instead of copying it (ADR-0001, packages first). It composes the platform's shell (`ShellLayout`, `ShellAppBar`, `ShellNavigationRail`, `ShellBottomNav`, `ShellUserMenu`) with the KVox brand lockup, builds the navigation from the destinations the slices declare, and owns the glue each host used to carry: the route renderer with its permission guard (`renderKvoxRoutes`), the in-app links the pages build (`defaultKvoxLinks`) and the AI-key-required state (`AiKeyRequired`). A host supplies only host facts: its own destinations, app bar actions, banners, overlays and user menu rows.

It reads no breakpoint. The five coupled breakpoint gates are the platform's and none is added here (`noBreakpoints.test.ts`, and `apps/web/src/__tests__/config/breakpointGates.test.ts`, which scans this package).

Status: filled (issue #629). With `brand`, it is the second `kvox-web` slice that imports the platform: exactly `@marinoscar/platform-web/shell/ui`, `/shell/headless` and `/identity/headless` (rule `host-neutral`, `HOST_NEUTRAL_SLICE_ALLOWED`).

## Entry point

`@marinoscar/kvox-web/shell`: `KvoxAppShell`, `createKvoxNavigation`, `withoutPinned`, `renderKvoxRoutes`, `defaultKvoxLinks`, `AiKeyRequired` and their types (`KvoxAppShellProps`, `CreateKvoxNavigationOptions`, `KvoxNavigation`, `KvoxNavigationSlice`, `KvoxSliceDestinationKey`, `RenderKvoxRoutesOptions`, `AiKeyRequiredProps`).

## Peer dependencies

`@marinoscar/platform-web`, `@mui/material`, `@mui/icons-material`, `react-router-dom` and `react`. The slice imports the `ui` index of the transcripts, notes, graph and ask slices for their destination data, so it needs those slices' peers too (a bundler tree-shakes the pages away).

## Configuration

None at runtime. Declare the navigation once, at module scope: the platform shell keys on its identity.

## Extension-point catalog

- `createKvoxNavigation({ include, extra, extraRoutes, settingsPath, settingsSections, settingsSurfaces, console, homePath, useRailPreference })`: which slice rows to list (`transcripts`, `notes`, `graph` for Knowledge, `review`, `ask`, `templates`), the host's own destinations (unpinned first, pinned last), the route prefixes they own and the drill-down surfaces. A row gated on `feature: 'graph'` is hidden by the shell unless the host registered the `graph` settings feature (`registerSettingsFeature`).
- `KvoxAppShell` props `actions`, `banners`, `overlays`, `userMenuItems`, `renderUserMenuItems`, `showThemeToggle` and `brand`.
- `renderKvoxRoutes(routes, { fallback })`: where a viewer without a route's permission is sent when the route names no `redirectTo`.
- `AiKeyRequired` `settingsPath` and `providerName`.

### Hosts

Web (server session): `<KvoxAppShell navigation={KVOX_NAVIGATION} actions={<NotificationBell />} banners={...} overlays={<WelcomeDialog />} />` as the layout route element, `apps/web/src/components/common/Layout.tsx`.

Desktop (local single user): `LocalIdentityProvider` and `ShellPreferencesProvider` above the router, then `<KvoxAppShell navigation={navigation} userMenuItems={[...]} />`; see the package README.

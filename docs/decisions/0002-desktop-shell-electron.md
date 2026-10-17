# ADR-0002: KVox Desktop shell: Electron

- Status: Accepted
- Date: 2026-10-17
- Related issues: epic #574, #582, #587

## Context

KVox Desktop must run the Node-based domain packages (`engines.node >=24`) and the React screens of `@marinoscar/kvox-web` on Windows, macOS and Linux. The shell decides how many runtimes ship and whether the packages run unchanged ([ADR-0001](0001-packages-first.md)).

## Decision

Electron, with this stack:

| Concern | Choice |
|---|---|
| Shell | Electron, exact pinned version whose bundled Node is 24 or later (the packages require `engines.node >=24`) |
| Build | electron-vite |
| Server | Nest 11 on Fastify 5, in an Electron `utilityProcess` |
| Renderer | React 19, MUI 9, React Router 7 (the versions `@marinoscar/kvox-web` expects) |
| Transport | Loopback HTTP and SSE on `127.0.0.1`, random port, per-launch token |
| Packaging | electron-builder, electron-updater |
| Tests | Vitest, Playwright for Electron |
| CI matrix | `windows-latest`, `macos-latest` (arm64), `macos-13` (x64), `ubuntu-latest` |

Targets:

| OS | Versions | Package |
|---|---|---|
| Windows | 10 and 11, x64 and arm64 | NSIS installer |
| macOS | 13 and later | DMG, notarized |
| Ubuntu | 22.04 and later | deb (primary); AppImage needs `libfuse2` |

The data folder is `app.getPath('userData')`: `%APPDATA%\KVox`, `~/Library/Application Support/KVox`, `~/.config/KVox`.

## Consequences

- Accepted trade-off: installer of about 120 to 180 MB and about 200 to 300 MB of RAM.
- One runtime language and one set of packages; no rewrite.
- Risks:
  - Node 24 inside Electron must be verified (#582).
  - Linux machines without a keyring: `safeStorage` falls back to `basic_text`; the key store must say so to the user.
  - Apple notarization is set up from day one, not at release time.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Tauri | Needs a bundled Node sidecar to run the packages: two runtimes. |
| .NET MAUI or Avalonia | Cannot run the Node packages. A rewrite duplicates the domain and violates [ADR-0001](0001-packages-first.md). |
| Wails or Flutter | Same as above. |
| Local web server opened in a browser | No keychain, no installer, poor experience. |

## Enforcement

- CI matrix on the four runners above.
- Verify the Electron-bundled Node is 24 or later before pinning the version (#582).
- Playwright for Electron end-to-end tests on every runner (#582).

## Related issues

#582 (stack spike), #587 (packaging).

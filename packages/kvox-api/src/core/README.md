# core

The helpers the domain slices of `@marinoscar/kvox-api` share, and the module that binds the host ports.

## Purpose and scope

Code that two or more slices need and that belongs to none of them. Moving it here is what cuts the import cycles between slices that the API had before (transcripts, search, graph and Ask all imported the notes slice, and notes imported a controller of transcripts).

Status: experimental.

- **Binding the ports**: `KvoxPortsModule.forRoot({ ports })` is global and binds each bound port to its token (`useClass`, `useExisting`, `useValue` or `useFactory`). It throws at start-up naming every required port left unbound. `events` and `audit` are optional; the defaults are `KvoxEventEmitterEvents` (over Nest's `EventEmitter2` when `@nestjs/event-emitter` is installed, otherwise a private emitter) and a no-op audit.
- **Authentication**: `KvoxAuth(...permissions)` guards a route or controller; `KvoxAuthFromOptions('settingsRead')` does the same for a route whose permission strings belong to the host (the slice module provides its option-name to string map under `KVOX_AUTH_PERMISSIONS`); `KvoxAuthGuard` answers 401 when the identity port returns no principal and 403 when a listed permission is missing (an option with no string fails closed, 500); `CurrentKvoxPrincipal()` hands the handler the principal. Permissions come only from the normalised principal.
- **Documenting guarded routes**: the decorators only record what a route needs. A slice's `forRoot` calls `documentKvoxAuth(controllers, permissions)`, which applies the decorators the host's documenter returns (`setKvoxAuthDocumenter`; the default is a plain bearer-auth marker when `@nestjs/swagger` is installed). The web edition documents a route exactly as its own `@Auth(...)` does, so a moved route keeps its entry in the API document.
- **AI helpers**: `aiProviderThrottleKey(userId)` (one bucket per user, never a shared one), `TRANSCRIPTION_THROTTLE_KEY`, and the token budget (`computeTokenBudget`, `outputTokensForPrompt`, `budgetRefusalMessage`, `assertWithinBudget`, which refuses with numbers and throws `KvoxAiBudgetError`, and never truncates).
- **Streaming**: `StreamFlusher` (about 250 ms or N characters, whichever first) and the offset-resumable SSE helpers (`KvoxStreamCursor`, `resolveStreamOffset`, `parseLastEventId`, the frame builders) and `KvoxRowStreamPoller`, the poll loop the note and Ask streams share (a durable row, read by primary key every interval, tailed as SSE; a push is rejected because the job may run on another replica).
- **HTTP**: `versionETag` and `matchesETag`.
- **Events**: `KvoxEventEmitterEvents`.
- **Database**: `Prisma.sql`, `Prisma.raw`, `Prisma.join` from `@prisma/client-runtime-utils`, loaded on first use.

## Entry point

`@marinoscar/kvox-api/core`. The slice depends on the `ports` slice only.

## Peer dependencies

`@marinoscar/kvox-contract`, `@nestjs/common`, `@nestjs/core`, `reflect-metadata`, `rxjs` and `zod` (the slice's own and `ports`'), all required. Three peers are optional and loaded lazily, so importing the slice never needs them: `@nestjs/event-emitter` (the shared emitter), `@nestjs/swagger` (the bearer-auth marker) and `@prisma/client-runtime-utils` (the `Prisma` helper).

## Configuration

None. `KvoxPortsModule.forRoot` takes the port bindings and, optionally, the modules the bound classes need.

## Extension-point catalog

`KvoxPortsModule` and `KvoxPortBindings` are the extension points of this slice: a host calls `forRoot` with a binding per port. `KVOX_BRAND` is the optional token under which `forRoot({ brand })` provides the product name and footer line to the PDF exporter. `KVOX_AUTH_PERMISSIONS` is the token under which a slice module provides its permission map, and `setKvoxAuthDocumenter` is the hook a host uses to describe authenticated routes in its API document. See the [ports catalog](../ports/README.md#extension-point-catalog) for the tokens.

### Desktop

`KvoxPortsModule.forRoot({ ports, brand })` is how Desktop binds its adapters, and `KVOX_BRAND` is how it names itself in a PDF footer; the guide shows the whole application module. See [the KVox Desktop guide](../../../../docs/guides/kvox-desktop.md#wiring-the-api).

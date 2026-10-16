# core

The helpers the domain slices of `@marinoscar/kvox-api` share.

## Purpose and scope

Code that two or more slices need and that belongs to none of them: the AI provider throttle key, the token-budget helpers, the ETag helpers and the other pieces that today create cross-slice import cycles in the API. Moving them here is what lets Epic 6 split the slices.

Status: scaffold. The slice exports one marker, `KVOX_API_CORE`; the helpers arrive with issue 5.4.

## Entry point

`@marinoscar/kvox-api/core`. The slice depends on the `ports` slice only.

## Peer dependencies

`@marinoscar/kvox-contract`, `@nestjs/common`, `@nestjs/core`, `reflect-metadata`, `rxjs` and `zod` (the slice's own and `ports`'), all required.

## Configuration

None.

## Extension-point catalog

None.

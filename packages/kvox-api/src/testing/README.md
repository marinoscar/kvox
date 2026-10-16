# testing

Test doubles for the ports of `@marinoscar/kvox-api`, and the conformance suite every port binding must pass.

## Purpose and scope

In-memory fakes of each port and `describeKvoxPortsConformance`, which runs the same assertions against the fakes and against the web-edition adapters in the app, so a Desktop adapter can prove itself against the same suite. Import it from tests only.

Status: scaffold. The slice exports one marker, `KVOX_API_TESTING`; the fakes and the suite arrive with issue 5.4.

## Entry point

`@marinoscar/kvox-api/testing`. The slice depends on the `ports` and `core` slices.

## Peer dependencies

`@marinoscar/kvox-contract`, `@nestjs/common`, `@nestjs/core`, `reflect-metadata`, `rxjs` and `zod` (inherited from `ports` and `core`).

## Configuration

None.

## Extension-point catalog

None. The conformance suite is the contract a binding implements, not an extension point.

# ports

The host ports of `@marinoscar/kvox-api`: the interfaces and injection tokens through which a domain slice reaches everything outside the domain.

## Purpose and scope

One port per outside responsibility: AI (`KVOX_AI`), object store, jobs, identity, notifications, events, Prisma, settings, secrets and audit. A slice depends on these and on nothing of a host, so the web edition (the platform) and Desktop (local adapters) both bind them. This slice imports no `@marinoscar/platform-*` package.

Status: scaffold. The slice exports one marker, `KVOX_API_PORTS`; the ports arrive with issue 5.4.

## Entry point

`@marinoscar/kvox-api/ports`. The slice depends on no other slice.

## Peer dependencies

`@marinoscar/kvox-contract`, `rxjs` and `zod`, all required.

## Configuration

None. A host provides each token in its own module.

## Extension-point catalog

None yet. Each port becomes an `@extensionPoint` when issue 5.4 declares it.

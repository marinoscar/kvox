# ADR-0001: Packages first: domain code is written once and shared by every host

- Status: Accepted
- Date: 2026-10-17
- Related issues: epic #574, #577, #579, #580

## Context

KVox now has two hosts of the same domain: the web edition (`apps/api` and `apps/web` in this repository) and KVox Desktop (`marinoscar/kvox-desktop`). The domain already lives in the published `@marinoscar/kvox-*` packages: transcripts, notes, search, the graph and Ask. One part does not: the AI harness (prompts, pipelines, structured-output rules, the tool loop, budgets, the task-to-model choice, error mapping) is partly in `apps/api/src/ai-port` and serves only the web edition. Two copies of domain code drift, and every bug is fixed twice.

## Decision

All domain behaviour lives in the published `@marinoscar/kvox-*` packages. That includes transcripts, notes, search, the graph, Ask, and the AI harness.

A host contains only:

- port bindings (the ten ports of `@marinoscar/kvox-api/ports` and `KvoxWebHost`);
- the shell (navigation, settings hub, theme);
- packaging;
- host-specific glue (settings namespaces, onboarding).

The hosts are KVox web (`apps/api` + `apps/web`) and KVox Desktop. Rules:

1. A feature needed by both hosts is implemented in a package first, then mounted by each host.
2. A host never copies or forks slice code, prompts, schemas or parsers.
3. If a host needs different behaviour, that is an option of the package (a `forRoot` option or a port), not a fork.
4. New shared code that is not yet a package (today: `apps/api/src/ai-port`) is moved into a package before a second host uses it (#579).

## Consequences

- Package releases gate host features. A Desktop feature waits for the package release that carries it.
- Desktop depends on npm publishing (#577).
- Each feature costs more upfront work: package API, tests, release.
- In return there is no drift between hosts and one fix reaches both.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Copy the domain code into Desktop | The copies drift and every bug is fixed twice. |
| Put Desktop in this monorepo as `apps/desktop` | It skips proving that the packages work for an outside consumer. Still possible later; the decision is about where the code lives, not which repository holds the host. |

## Enforcement

- The host-neutral rule and `npm run check:kvox-slice-peers` ([../PACKAGES.md](../PACKAGES.md)).
- ESLint package import rules ([../PACKAGES.md](../PACKAGES.md)).
- Conformance kits: `describeKvoxPortsConformance` and the slice kits ([../specs/kvox-ports.md](../specs/kvox-ports.md)).
- The bare host (`examples/bare-host`) as a second consumer in CI ([../../examples/bare-host/README.md](../../examples/bare-host/README.md)).
- The AI parity test planned in #580: web and Desktop bindings must build byte-identical provider requests.
- Review checklist item for Desktop pull requests: "no domain logic in this repository".

## Related issues

Epic #574; #577 (publish), #579 (move the AI layer into a package), #580 (AI parity test).

# Guides

Consumer guides: documents for engineers who build a product on the published `@marinoscar/kvox-*` packages rather than on this repository's web edition. A guide says what to install, what to implement and what to expect, and links the code that proves it. Package standard: [PACKAGES.md](../PACKAGES.md). The contract of the host ports: [specs/kvox-ports.md](../specs/kvox-ports.md).

| Guide | What it covers |
|---|---|
| [kvox-desktop.md](kvox-desktop.md) | KVox Desktop (offline, React + Node, embedded PostgreSQL, GitHub Copilot SDK): the packages and slices, installing them, building the embedded database, the ports to implement, a `KVOX_AI` adapter sketch for the Copilot SDK, the in-process job runner, wiring the API and the web host, what changes offline feature by feature, the conformance kits, the version policy and troubleshooting. |

The working reference for every guide is [`examples/bare-host/`](../../examples/bare-host/README.md): a Nest app that installs the packed tarballs with no platform package, runs on PostgreSQL with pgvector and on PGlite, and passes an end-to-end test in CI. A guide quotes code from it and says so; any block that is not compiled is marked `Illustrative — not compiled` on its first line.

## Keeping a guide current

- A new slice also updates the Desktop guide's Install and offline tables ([PACKAGES.md, Adding a slice](../PACKAGES.md#adding-a-slice)).
- A change to a port (an added member, a changed rule) is written in [specs/kvox-ports.md](../specs/kvox-ports.md) first and then in the guide's "Ports to implement".
- `apps/api/test/docs-links.spec.ts` checks every relative link in this folder, and fails if a package README stops linking the Desktop guide.

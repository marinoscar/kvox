---
"@marinoscar/kvox-contract": minor
"@marinoscar/kvox-db": minor
"@marinoscar/kvox-api": minor
"@marinoscar/kvox-web": minor
---

Document how to consume the domain packages from a host that is not the web edition. Every package README and every slice README gains a `### Desktop` note that links the new KVox Desktop consumer guide (`docs/guides/kvox-desktop.md`): the packages and slices, the install lines and optional peers, the embedded database (PGlite or a bundled PostgreSQL, the `kvox-db sync --names after-host` prepare sequence), the ten ports to implement with their rules and the bare-host reference classes, a sketch of the GitHub Copilot SDK `KVOX_AI` adapter, the in-process job runner, the API and web wiring, what changes offline feature by feature, the conformance kits to run and the version policy. No code or contract changes.

# Changesets

This folder holds the pending release notes of the `@marinoscar/kvox-*`
packages. Those packages do not exist yet: they arrive in Phase 2 (Epic 5,
issue 5.1), which also adds them to the `fixed` group in
[`config.json`](config.json). Until then **no package needs a changeset**, and
`npx changeset status` reports nothing to release.

The applications (`api`, `web`, `cli`) and `@app/shared` are listed under
`ignore` in `config.json`: they are versioned by their own rules (the CLI by the
version bump described in `CLAUDE.md`), never through a changeset.

- Once a `@marinoscar/kvox-*` package exists, run `npx changeset` in any pull
  request that changes it, pick the package(s) and the bump, and write one line
  of release notes for a reader of the changelog. Commit the generated
  `.changeset/<name>.md` with the change.
- `npx changeset --empty` records that a change has no release impact.
- `pre.json` means the packages are in pre-release mode: releases are
  `x.y.z-next.N` on the `next` dist-tag. Do not edit or delete it by hand.
- `npm run version-packages` applies pending changesets (the maintainer does
  this at release time, not the PR author).

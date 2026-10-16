# The `@marinoscar/kvox-*` packages

How the four publishable KVox packages are laid out, documented, checked and released. The platform packages (`@marinoscar/platform-*`) follow the same standard in the EnterpriseAppBase repository; this page adapts it to KVox. Release procedure: [runbooks/release-kvox-packages.md](runbooks/release-kvox-packages.md). Epic: marinoscar/kvox#486, this pipeline: #487.

## Contents

- [The packages](#the-packages)
- [Layout: slices and entry points](#layout-slices-and-entry-points)
- [The README](#the-readme)
- [TSDoc](#tsdoc)
- [TypeDoc and the API reference](#typedoc-and-the-api-reference)
- [Adding a slice](#adding-a-slice)
- [Peer dependencies per slice](#peer-dependencies-per-slice)
- [The contract peer range](#the-contract-peer-range)
- [The host-neutral rule](#the-host-neutral-rule)
- [Checks and commands](#checks-and-commands)
- [CI](#ci)
- [Versioning](#versioning)

## The packages

| Package | Folder | Module format | Entry points today |
|---|---|---|---|
| `@marinoscar/kvox-contract` | `packages/kvox-contract` | dual ESM + CommonJS | `.`, `./transcription`, `./transcripts`, `./search`, `./notes`, `./graph`, `./ask`, `./ontology`, `./errors`, `./schemas/transcript-export.v1.json` |
| `@marinoscar/kvox-db` | `packages/kvox-db` | CommonJS, plus the `kvox-db` bin | `.` |
| `@marinoscar/kvox-api` | `packages/kvox-api` | CommonJS (`tsc`, decorator metadata) | `./core`, `./ports`, `./testing` |
| `@marinoscar/kvox-web` | `packages/kvox-web` | ESM | `./core` |

Every package: `"version"` moved by Changesets (the source says `0.0.0`), `"license": "MIT"`, `engines.node >=24`, `publishConfig` `{ "access": "public", "provenance": true }`, a `repository.directory`, and a `files` list of `dist`, `README.md`, `CHANGELOG.md` and `LICENSE` (plus `bin`, `schema`, `migrations`, `raw-sql-indexes.json`, `extensions.json` for `kvox-db`). `LICENSE` is copied from the repository root by the `prepack` script (`scripts/kvox-packages/copy-license.mjs`) and is git-ignored in the package.

The four packages are one Changesets `fixed` group: they always share one version, so a consumer never mixes `kvox-api@0.1.0-next.3` with `kvox-contract@0.1.0-next.2`. The apps (`api`, `web`, `cli`) and `@app/shared` are in `ignore`; `apps/api` and `apps/web` depend on the packages with a `*` workspace range.

`@marinoscar/kvox-contract` is dual because three kinds of consumer load it. Its build is `tsc -p tsconfig.cjs.json && tsc -p tsconfig.esm.json && node ../../scripts/kvox-packages/write-dist-stubs.mjs`. A `.d.ts` takes its module format from the nearest `package.json`; the package is `"type": "module"`, so `dist/cjs` gets a stub `package.json` of `{"type":"commonjs"}` or a CommonJS consumer fails with TS1479. `exports` points the `import` and `require` conditions at their own trees.

## Layout: slices and entry points

A **slice** is a folder directly under `packages/kvox-<pkg>/src/`. Each slice is one entry point (`./<slice>` in `exports`, `src/<slice>/index.ts`), has a `README.md`, and may import another slice of its package only when `packages/kvox-slices.json` lists it, and only through that slice's `index.ts` (ESLint rule B, `eslint.config.mjs`). A package with a single entry (`kvox-db`) has `src/index.ts` at the root that re-exports its slices. `kvox-contract` is the exception: its root exports only `KVOX_CONTRACT_PACKAGE`, because a root that re-exports every slice makes TypeDoc attribute each declaration to the root entry and leave the slice entries as bare references (which fail the `@stability` check). A consumer imports a slice subpath.

```
packages/kvox-api/
  package.json  tsconfig.json  tsconfig.build.json  typedoc.json  README.md
  src/core/index.ts  src/core/README.md
  src/ports/index.ts src/ports/README.md
  src/testing/index.ts src/testing/README.md
  test/jest.config.js  test/core.spec.ts
```

`packages/kvox-slices.json` is the slice graph, `{ "kvox-api": { "core": ["ports"] } }`. A slice may be declared before its folder exists; a folder under `src/` that the file does not declare is an error. Both data files are **append-only**: later issues add slices, they never rename or remove one, because a slice name is a published subpath.

Import rules for sources (ESLint, `npm run lint:packages`): never a deep import into another package (`src/`, `dist/`, `internal/`), never a relative path that leaves the package, never `@app/shared`. The contract imports only `zod` and its own files. Keep the `.js` extension in every relative import of an ESM or NodeNext package; without it the typecheck can pass and a consumer fails with `ERR_MODULE_NOT_FOUND`.

Subpaths are the package's public API. Document a subpath, or do not export it; an undocumented export fails `check:kvox-package-docs`. An `exports` entry whose value is a plain string is a data file shipped as-is (the contract's `./schemas/transcript-export.v1.json`): the README must name it, and `typedoc.json` has no entry point for it.

## The README

Every package README has this shape; `scripts/kvox-packages/check-package-docs.mjs` enforces it. The first heading is `# @marinoscar/kvox-<pkg>` followed by a one-paragraph summary, then exactly these fifteen `##` sections in this order, each with text (write "None." and the reason when there is nothing to say):

1. **Purpose and scope** - what the package owns and does not. Holds a line `Status: <state>` (`Status: scaffold` until Epic 6 or 7 fills the package) and the list of entry points, each with a link to its slice README.
2. **Install and peer dependencies** - the install command, then tables of required and optional peers with ranges and which slice needs each.
3. **Quick start** - the smallest working use.
4. **Configuration** - options and environment variables.
5. **Extension-point catalog** - every symbol tagged `@extensionPoint` in TSDoc, by name.
6. **Data** - tables and files the package owns.
7. **Permissions and settings** - permission strings and settings keys it relies on.
8. **UI** - pages, slots and theme tokens.
9. **Infra** - deployment configuration it ships.
10. **Observability** - logs, metrics, spans.
11. **Security notes** - what it must never do.
12. **Conformance suite** - the executable proof a binding or host is correct.
13. **Upgrade notes** - what a consumer changes between versions.
14. **Troubleshooting** - the failures seen and their fixes.
15. **Links** - the standard, the runbook, the dev commands.

The checker also requires that the README names every `exports` entry (`@marinoscar/kvox-api/core`; the root is the package name) and that every relative link resolves.

A **slice README** (`src/<slice>/README.md`) has the title `# <slice>`, a sentence, then five `##` sections: **Purpose and scope** (with `Status:` while it is a scaffold), **Entry point**, **Peer dependencies**, **Configuration** and **Extension-point catalog**. Package READMEs link to a slice README by path and anchor, for example `src/ports/README.md#extension-point-catalog`.

## TSDoc

Every exported declaration (variable, function, class, interface, type alias, enum, and each public property, method or accessor) carries a TSDoc comment. `tsdoc/syntax` (ESLint) rejects a comment that does not parse; TypeDoc rejects an undocumented export (`typedoc.base.json` `requiredToBeDocumented`). Two block tags are declared in the root `tsdoc.json` on top of TypeDoc's:

| Tag | Meaning | Checked by |
|---|---|---|
| `@stability stable\|experimental\|deprecated` | The compatibility promise. Required on every top-level export of an entry point. `stable`: changes follow semver once the package leaves pre-release; `experimental`: may change in any release; `deprecated`: to be removed, say what replaces it with `@deprecated`. | `check-package-docs.mjs` (`api-reference`) |
| `@extensionPoint` | The symbol is something a host or app implements, provides or registers. It must be named in the README's "Extension-point catalog". | `check-package-docs.mjs` (`api-reference`) |

```ts
/**
 * Where the command writes.
 *
 * @stability experimental
 */
export interface KvoxDbIo { /* ... */ }
```

Describe behaviour and the reason in the comment, name units, and use `{@link Symbol}` for references (an unresolved link fails TypeDoc).

## TypeDoc and the API reference

A package whose public types are mostly `z.infer` shapes (`kvox-contract`) may drop `"Property"` from `requiredToBeDocumented` in its own `typedoc.json`, with a comment saying why; every exported declaration still needs TSDoc and `@stability`. `typedoc.base.json` holds the shared options (private and internal members excluded, validation of undocumented, unexported and unresolved items treated as errors, the two extra block tags). Each package's `typedoc.json` extends it and sets `tsconfig`, `entryPoints` (one `./src/<slice>/index.ts` per exported subpath, `./src/index.ts` for the root), `out` (`docs-api/html`) and `json` (`docs-api/api.json`). The `docs-api/` folder is generated and git-ignored.

```bash
npm run docs:kvox-packages          # TypeDoc for the four packages
npm run check:kvox-package-docs     # docs, then the standard above
```

`check-package-docs.mjs` reads `docs-api/api.json` for the `@stability` and `@extensionPoint` rules and compares `typedoc.json` `entryPoints` with the `exports` map in both directions. CI uploads the HTML as the `kvox-api-reference` artifact.

## Adding a slice

1. Create `packages/kvox-<pkg>/src/<slice>/index.ts` (and `README.md`, with the five sections).
2. Add the slice to `packages/kvox-slices.json` with the slices it imports, and to `packages/kvox-slice-peers.json` with the packages its files import.
3. Add the entry to the package's `exports` (`"./<slice>"` with `types` and `default` under `dist/<slice>/`) and to its `typedoc.json` `entryPoints`.
4. Add a peer to `package.json` `peerDependencies` (optional in `peerDependenciesMeta` unless a universal slice needs it) only if the slice imports a package the package does not list yet.
5. Name the new subpath in the package README and link the slice README there.
6. Add a changeset (`npx changeset`).
7. Run `npm run lint:packages`, `build:kvox-packages`, `check:kvox-slice-peers`, `check:kvox-package-docs` and `check:kvox-pack`.

## Peer dependencies per slice

Libraries with module-level state (Nest's container, React's dispatcher, Zod's classes, MUI's theme) must exist once in a host. The packages therefore declare them as **peers**, never dependencies, and `scripts/kvox-packages/check-slice-peers.mjs` keeps the declaration, the per-slice data and the source in agreement. A host installs only the peers of the slices it imports. Print the table with `node scripts/kvox-packages/check-slice-peers.mjs --table`.

Data lives in two files (both append-only):

| File | Content |
|---|---|
| `packages/kvox-slices.json` | slice -> slices it may import |
| `packages/kvox-slice-peers.json` | per package and slice, `{ "peers": [...] }`: every package its own files import; plus `$universal`, `$implies`, `$reserved` and `$hostOnly` |

- `$universal`: the slices every consumer of the package gets (`"*"` for all). The peers of these slices, with the slices they depend on, are the package's **required** peers. Any other peer must be `optional` in `peerDependenciesMeta`.
- `$implies`: `{ "react-dom": ["react"] }`. Installing the key brings the values with it, so a slice that lists `react-dom` may also import `react`.
- `$reserved`: optional peers declared ahead of the slice that will import them (Epic 6 and 7). Move the entry into the slice when it arrives.
- `$hostOnly`: optional peers no slice may import (`@marinoscar/platform-api` and `@marinoscar/platform-web`, used by host wiring only).

The rules (each violation prints as `[rule] message`):

1. **graph** - slice keys are packages, slice dependencies are declared slices of the same package, no cycle, no undeclared folder under `src/`.
2. **peers-data** - every declared slice has a peers entry and every entry is a declared slice.
3. **manifest** - `package.json` `peerDependencies` match the data (required versus optional, none missing, none unaccounted for, no host-only peer in a slice).
4. **imports** - every external import of a slice's files is a peer of that slice or of a slice it depends on (directly or through `$implies`), or a dependency of the package. Comments are ignored. Files at the root of `src/` may use any peer of the package.
5. **app-installs** - with `--app <dir>` (CI passes `apps/api` and `apps/web`): an app that imports `@marinoscar/kvox-<pkg>/<slice>` lists the package and every peer of that slice in its own `package.json` or the root one.
6. **host-neutral** - see below.

A `@marinoscar/platform-*` peer is pinned to one exact version (`check:platform-pin` requires it of every entry in the repository), so these two optional peers move with the platform pin.

## The contract peer range

`@marinoscar/kvox-api` and `@marinoscar/kvox-web` list `@marinoscar/kvox-contract` as a required peer with the range `>=0.0.0-0 || >=0.1.0-0`. The odd shape is deliberate and has two halves:

- Changesets bumps the **major** version of a package whose peer dependency receives a minor or major bump, even inside a `fixed` group (so every first release would come out as `1.0.0-next.0`). `.changeset/config.json` therefore sets `onlyUpdatePeerDependentsWhenOutOfRange: true` (under `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH`), which bumps a dependent only when the new version leaves the peer range.
- A pre-release version satisfies a range only when some comparator names the same `major.minor.patch`. `>=0.0.0-0` covers the unversioned source (`0.0.0`) and every stable release; `>=0.1.0-0` covers `0.1.0-next.N`. A line of pre-releases with another `major.minor.patch` (for example `0.2.0-next.0`) leaves the range, and Changesets then bumps the packages to a major version. **Before the first pre-release of a new minor line, widen the range** (add `|| >=0.2.0-0`) in both `package.json` files, in the same pull request.

The packages are released together, so a consumer who installs the four from one `next` tag gets one version. The range is not what keeps them in step; the `fixed` group and the release gate (which refuses a release whose four versions differ) do.

## The host-neutral rule

**No file under `packages/kvox-api/src/**` or `packages/kvox-web/src/**` may import `@marinoscar/platform-*`.** The second host of the domain, KVox Desktop, runs offline with local adapters and never installs the platform. A slice that imported the platform could not be installed there.

What to do instead: depend on a port from `@marinoscar/kvox-api/ports` (AI, object store, jobs, identity, notifications and so on). The web edition binds each port to a platform slice in one place, `apps/api/src/platform-kvox/` (issue 5.4); Desktop binds its own. The two optional `@marinoscar/platform-*` peers exist for those bindings' helpers, listed in `$hostOnly`, and no slice may list them.

The rule is executable: `npm run check:kvox-slice-peers` fails with `[host-neutral]` naming the file and the specifier, and the fixtures in `scripts/kvox-packages/test/fixtures/` pin both outcomes (`npm run test:kvox-scripts`). It complements ESLint's deep-import rule, which bans `@marinoscar/platform-*/src`, `/dist` and `/internal` paths everywhere.

## Checks and commands

| Command | What it does |
|---|---|
| `npm run build:kvox-packages` | Builds the four packages (`build:packages` is an alias). |
| `npm run typecheck:kvox-packages` | `tsc --noEmit` in each. |
| `npm run test:kvox-packages` | Vitest (contract, db, web) and Jest (api); `test:packages` also runs the script tests. |
| `npm run test:kvox-scripts` | `node --test scripts/kvox-packages/test/`: the check scripts against fixtures, including `host-neutral`. |
| `npm run lint:packages` | ESLint over `packages/kvox-*/src` (deep imports, slice direction, TSDoc, contract imports). |
| `npm run docs:kvox-packages` | TypeDoc for the four packages. |
| `npm run check:kvox-slice-peers` | The six rules above, for the packages and then for `apps/api` and `apps/web`. |
| `npm run check:kvox-package-docs` | `docs:kvox-packages`, then the README, TSDoc and TypeDoc standard. |
| `npm run check:kvox-pack` | `npm pack --dry-run` of each package against its manifest. Run after the build. |
| `node scripts/kvox-packages/check-single-instance.mjs --root . --guard '@marinoscar/platform-*' --guard '@marinoscar/kvox-*'` | One copy of every singleton library and package. |
| `npx changeset status --since=origin/main` | Fails when a package source changed without a changeset. |
| `npm run version-packages` | `changeset version` and a lockfile refresh. A maintainer step, run by the release workflow. |

The scripts live in `scripts/kvox-packages/` and are modelled on the EnterpriseAppBase scripts of the same names, parameterised by constants at the top (`PREFIX`, `SLICES_FILE`, `PEERS_FILE`). `check-single-instance.mjs` there wraps the repository-wide `scripts/check-single-instance.mjs` and adds `--guard` patterns.

## CI

`.github/workflows/kvox-packages.yml` runs on pull requests and pushes that touch `packages/kvox-*/**`, `packages/kvox-*.json`, `scripts/kvox-packages/**`, `.changeset/**` or the workflow itself:

- **build**: `npm ci`, build, typecheck, lint, the slice-peers check, the script tests, package tests, the pack check, and a smoke import of the built package from both module systems (`require('@marinoscar/kvox-api/core')`, `await import('@marinoscar/kvox-contract')`).
- **package-docs**: TypeDoc, the docs check, and the `kvox-api-reference` artifact.
- **single-instance**: the single-instance check over the platform and KVox packages.
- **changeset-status**: fails a pull request that changes package sources without a changeset.

`.github/workflows/kvox-release.yml` versions and publishes; see the runbook. The application images keep their own `deploy.yml` flow.

## Versioning

Changesets runs in **pre mode** on the `next` tag (`.changeset/pre.json`), so releases are `0.1.0-next.N` on the `next` dist-tag. Add a changeset with `npx changeset` in every pull request that changes a package; `npx changeset --empty` records that a change has no release impact. Do not edit `pre.json` by hand. Leaving pre mode: [the runbook](runbooks/release-kvox-packages.md#leaving-pre-mode).

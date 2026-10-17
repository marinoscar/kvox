# Runbook: release the `@marinoscar/kvox-*` packages

Use this to publish `@marinoscar/kvox-contract`, `-db`, `-api` and `-web` to public npm, to understand what the release workflow did, or to roll a release back. The layout and checks of the packages are in [../PACKAGES.md](../PACKAGES.md). The workflow is `.github/workflows/kvox-release.yml`.

## How a release works

The five packages are one Changesets `fixed` group in **pre mode** on the `next` tag, so they always share one version and every release is `0.1.0-next.N` on the `next` dist-tag.

1. A pull request that changes a package carries a changeset (`npx changeset`). `kvox-packages.yml` and the `tooling` job of `ci.yml` fail it otherwise.
2. After the change merges to `main`, the **version** job opens (or updates) the pull request `kvox-release/version`: `changeset version` bumps the five versions, writes the changelogs and refreshes `package-lock.json`.
3. Merging that pull request pushes to `main` with no pending changeset. The **gate** job reads the version and asks the public registry whether the five names exist and whether that version is already published. It uses no credentials, and any registry error makes it answer "not ready".
4. If the repository variable `NPM_PUBLISH_ENABLED` is `true` and the gate is ready, **publish** runs in the protected environment `npm-publish`: build, `check:kvox-slice-peers`, `check:kvox-pack`, then `npm publish` of each package with provenance, then the git tag `kvox-packages-v<version>`. Otherwise **publish-dry-run** builds, packs and uploads the five tarballs (`marinoscar-kvox-contract-<version>.tgz` and so on) as the `kvox-tarballs` artifact.

No npm token exists anywhere: `publish` authenticates with OIDC trusted publishing (`id-token: write`) and `NPM_CONFIG_PROVENANCE=true` signs the packages so consumers can run `npm audit signatures`. The workflow installs npm 11.5.1 or later, which trusted publishing needs. It never passes `--tag latest`: the dist-tag comes from `.changeset/pre.json`, and the job refuses a missing or `latest` tag.

## Owner prerequisites (once)

Publishing stays off until the owner does these steps. Until then every release is a dry run.

1. **Bootstrap the five names on npm.** A trusted publisher can only be attached to a package that exists. From a laptop logged in to npm as the owner of the `@marinoscar` scope, publish a placeholder of each package once (do this from a scratch copy of the package, with `"version": "0.0.0-bootstrap"`; never from a build you intend to release):

   ```bash
   cd "$(mktemp -d)"
   for p in contract db api web; do
     mkdir "kvox-$p" && cd "kvox-$p"
     printf '{"name":"@marinoscar/kvox-%s","version":"0.0.0-bootstrap","description":"Name reservation.","license":"MIT"}\n' "$p" > package.json
     npm publish --access public --tag bootstrap
     cd ..
   done
   ```

   The `bootstrap` tag keeps the placeholder off `latest` and `next`.
2. **Attach the trusted publisher to each package** (npmjs.com, package Settings, Trusted Publisher, GitHub Actions): organization/user `marinoscar`, repository `kvox`, workflow filename `kvox-release.yml`, environment `npm-publish`.
3. **Create the GitHub environment** `npm-publish` (Settings, Environments): a required reviewer, and deployment branches limited to `main`. No secrets.
4. **Set the repository variable** `NPM_PUBLISH_ENABLED` to `true` (Settings, Secrets and variables, Actions, Variables). Leave it unset or `false` to keep the dry run.
5. Allow GitHub Actions to create pull requests (Settings, Actions, General, Workflow permissions) so the version job can open `kvox-release/version`. Pull requests opened with the default token do not trigger other workflows; to run CI on the version pull request, close and reopen it, or push an empty commit to the branch.

## Releasing

1. Merge the pull request that carries the changeset. Wait for **KVox release / Version pull request** to open `kvox-release/version`.
2. Review the version pull request: five `package.json` versions equal, `CHANGELOG.md` per package, the lockfile diff limited to the workspace entries, `.changeset/pre.json` listing the consumed changeset.
3. Merge it. Watch **Release gate** (its summary shows the version, the variable and the registry state), then **Publish to npm** (approve the environment when asked) or **Publish dry run**.
4. Verify:

   ```bash
   for p in contract db api web; do npm view "@marinoscar/kvox-$p@next" version dist.tarball; done
   npm audit signatures        # in a project that installed them
   ```

   All five report the same version. The git tag `kvox-packages-v<version>` exists.

To inspect a dry run, download the `kvox-tarballs` artifact and `tar -tzf` each tarball: only `dist/`, `README.md`, `CHANGELOG.md`, `LICENSE` and `package.json` (plus `bin/` and the schema folders for `kvox-db`).

To release after fixing the prerequisites without a new change, run **KVox release** from the Actions tab (`workflow_dispatch`); the gate re-evaluates the current version.

## When something goes wrong

| Symptom | Cause and fix |
|---|---|
| The release always dry-runs | `NPM_PUBLISH_ENABLED` is not `true`, or the gate summary says a name does not exist (bootstrap missing) or the registry answered an error. Fix the cause and re-run the workflow. |
| Gate warns "N of 4 packages are already published" | A previous publish stopped half way. Re-run **KVox release** from the Actions tab: the publish job skips the packages already at that version and publishes the rest. |
| Gate fails: "fixed group is out of step" | The five `package.json` versions differ. Revert the offending commit; never edit a version by hand. |
| `npm publish` fails with `ENEEDAUTH` or an OIDC error | The trusted publisher is missing or mismatched (workflow filename, environment, repository), or npm is older than 11.5.1. Check step 2 above. |
| `changeset version` fails on a package that does not exist | `.changeset/config.json` `fixed` names a package whose folder was removed. Keep all five. |
| The version pull request has no CI | Expected with the default token; see prerequisite 5. |

## Rolling back

**Before the version pull request merges:** close it. Nothing was published.

**After a publish:** never `npm unpublish` a version a consumer may have installed. Deprecate it and release a fixed version:

```bash
for p in contract db api web; do
  npm deprecate "@marinoscar/kvox-$p@<version>" "<reason>; use <next version>"
done
```

Then fix forward: a new changeset, a new version pull request, a new release. To stop publishing at once, set `NPM_PUBLISH_ENABLED` to `false`; releases fall back to the dry run.

**Reverting the pipeline:** revert the pull request that introduced it. Nothing is published until the owner sets `NPM_PUBLISH_ENABLED=true`.

## Leaving pre mode

Pre mode ends when the packages are ready for a stable `latest` release (a decision for the owner, after the contract, db and ports are in use by both hosts).

1. In a pull request run `npx changeset pre exit`, which sets `"mode": "exit"` in `.changeset/pre.json`; add a changeset (`major` or `minor` as agreed).
2. Merge it, then merge the version pull request that follows: the versions become stable (`0.1.0` or `1.0.0`) and that `changeset version` run deletes `.changeset/pre.json`.
3. The publish job publishes without `--tag` once `pre.json` is gone, which npm treats as `latest`. Check that `latest` is what you want, then merge. Remove the `bootstrap` dist-tags if you like (`npm dist-tag rm @marinoscar/kvox-<pkg> bootstrap`).
4. To go back to pre-releases later, `npx changeset pre enter next` and merge the result.

## Links

- [PACKAGES.md](../PACKAGES.md): layout, README and TSDoc standard, peers per slice, the `host-neutral` rule
- [DEVELOPMENT.md](../DEVELOPMENT.md): repository tooling, including the single-instance check and changesets
- `.github/workflows/kvox-release.yml`, `.github/workflows/kvox-packages.yml`

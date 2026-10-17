---
'@marinoscar/kvox-db': patch
---

Add the `stable` naming policy to `kvox-db sync` (`--names stable`) and export `stableName(id)`: an installed domain migration is named `<package timestamp>_kvox_<slug>`, a pure function of the package migration id, so it no longer shifts when the platform or another package adds a migration. It is the new default for a host with no domain history (a fresh host should run `platform db sync --timestamp 2024-01-01T00:00:00Z` first so the platform tables sort before the domain's); `after-host` and `afterHostNames` are deprecated because their names move by a second whenever another package adds a migration. Existing installs keep their recorded names: the web app's `original` names and any `kvox.lock` policy are inferred from the lock and never changed.

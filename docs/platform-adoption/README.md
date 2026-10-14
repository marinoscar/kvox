# Platform adoption

This folder holds the frozen baseline for adopting the EnterpriseAppBase `@marinoscar/platform-*` packages in KVox. [module-classification.md](module-classification.md) is the hand-written part: for every top-level module of `apps/api/src`, `apps/web/src` and `apps/cli/src` it records a category (noise, backport, domain or kvox-divergence), the target slice or package, the roadmap issue that deals with it, and the KVox workaround for each backport. The migrations and the 14 shared Prisma models are classified there too. The measurements it rests on are pinned to EnterpriseAppBase `c20bade` and KVox `6e44e43` (2026-10-14).

The four `drift-baseline*` files are the raw reports. `drift-baseline.md` and `.json` compare KVox against EAB's `apps/` layout (the apps view; right for web, cli, prisma and infra). `drift-baseline-slices.md` and `.json` pair each KVox API base module with its packaged slice (the slice view; right for the API, because EAB's `apps/api/src` now holds only bindings). To regenerate, run EAB's `scripts/platform-drift.mjs` twice from a scratch directory (never from inside either repository) and build the slice view with the helper in this repository:

```bash
node <EAB>/scripts/platform-drift.mjs --app <KVOX> --base <EAB> --out <SCRATCH>/apps
bash <KVOX>/scripts/platform-adoption/make-slice-view.sh <EAB> <SCRATCH>/eab-slice-view
node <EAB>/scripts/platform-drift.mjs --app <KVOX> --base <SCRATCH>/eab-slice-view --areas api --out <SCRATCH>/slices
```

The four drift files are generated data and are never edited by hand, apart from replacing local absolute paths with `EnterpriseAppBase` and `kvox`. They are a baseline: a later re-run goes to new files, never over these. Leave them byte-for-byte as generated.

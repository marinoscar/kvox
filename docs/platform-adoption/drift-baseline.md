# Platform drift report

Generated 2026-10-14T23:17:50.628Z by `scripts/platform-drift.mjs` (schema 1).

| | Root | Commit |
|---|---|---|
| Base | `EnterpriseAppBase` | `c20bade53ad3c745b459976e361784e4f15d95ec` |
| App | `kvox` | `6e44e436171464c7a2ef87c1cc3c18def7c61771` |

## Identity replacements

Every value in this table, base or app, is replaced by its token on both sides before comparing, so these differences are ignored. A row marked "no" is unknown on one side and was not applied (pass the `--base-*`/`--app-*` flags).

| Placeholder | Base | App | Applied as |
|---|---|---|---|
| `__PRODUCT__` | `My App` | `KVox` | `__PRODUCT__` |
| `__SLUG__` | `my-app` | `kvox` | `__SLUG__` |
| `__SLUG_SNAKE__` | `my_app` | `kvox` | `__SLUG__` |
| `__SERVICE__` | `my-app-api` | `kvox-api` | `__SERVICE__` |
| `__REPO_SLUG__` | `marinoscar/EnterpriseAppBase` | `marinoscar/kvox` | `__REPO_SLUG__` |
| `__REPO_NAME__` | `EnterpriseAppBase` | `kvox` | `__SLUG__` |
| `__CLI__` | `appctl` | `kvox` | `__SLUG__` |
| `__CLI_UPPER__` | `APPCTL` | `KVOX` | `__CLI_UPPER__` |
| `__CLI_TITLE__` | `Appctl` | `Kvox` | `__CLI_TITLE__` |

## Areas

"Identical" counts identical plus normalised-identical files over every base file in the area (present on both sides, or base-only).

| Area | Root | Base files | Identical | Normalised-identical | Modified | Base-only | App-only | Lines +/- | Identical to base |
|---|---|---|---|---|---|---|---|---|---|
| api | `apps/api/src` | 265 | 2 | 0 | 21 | 242 | 1111 | +1652 / -603 | 0.8% |
| api-test | `apps/api/test` | 361 | 20 | 0 | 68 | 273 | 158 | +1842 / -3011 | 5.5% |
| web | `apps/web/src` | 269 | 18 | 3 | 64 | 184 | 642 | +6880 / -2760 | 7.8% |
| cli | `apps/cli/src` | 257 | 19 | 3 | 139 | 96 | 77 | +18357 / -13048 | 8.6% |
| prisma | `apps/api/prisma` | 59 | 16 | 0 | 3 | 40 | 23 | +478 / -20 | 27.1% |
| infra | `infra` | 32 | 0 | 3 | 11 | 18 | 2 | +61 / -361 | 9.4% |
| stack-agent | `apps/stack-agent/src` (not in app) | 7 | 0 | 0 | 0 | 7 | 0 | +0 / -0 | 0% |
| android | `apps/android` (not in app) | 26 | 0 | 0 | 0 | 26 | 0 | +0 / -0 | 0% |
| packages | `packages` | 3474 | 0 | 0 | 5 | 3469 | 46 | +236 / -96 | 0% |
| scripts | `scripts` | 16 | 1 | 0 | 3 | 12 | 1 | +61 / -281 | 6.3% |
| github | `.github` | 16 | 4 | 0 | 5 | 7 | 1 | +403 / -485 | 25% |

## Modules by changed lines

| Area | Module | Files | Modified | Base-only | App-only | Lines +/- | Identical to base |
|---|---|---|---|---|---|---|---|
| cli | `deploy` | 131 | 53 | 55 | 23 | +12551 / -8665 | 0% |
| web | `__tests__` | 394 | 36 | 121 | 225 | +3418 / -2095 | 7.1% |
| cli | `tui` | 87 | 24 | 20 | 39 | +3454 / -1257 | 8.3% |
| cli | `commands` | 10 | 8 | 2 | 0 | +1752 / -1271 | 0% |
| cli | `node` | 60 | 39 | 7 | 3 | +381 / -1581 | 19.3% |
| api | `common` | 60 | 9 | 13 | 36 | +685 / -252 | 8.3% |
| github | `workflows` | 9 | 4 | 5 | 0 | +379 / -466 | 0% |
| web | `components/navigation` | 5 | 4 | 0 | 1 | +697 / -31 | 0% |
| web | `pages/Admin` | 21 | 3 | 1 | 17 | +701 / -16 | 0% |
| web | `(root)` | 4 | 3 | 0 | 0 | +321 / -288 | 25% |
| api-test | `integration` | 12 | 5 | 0 | 6 | +63 / -542 | 16.7% |
| api-test | `jobs` | 19 | 9 | 8 | 1 | +32 / -536 | 5.6% |
| api-test | `storage` | 6 | 1 | 5 | 0 | +328 / -187 | 0% |
| api-test | `settings` | 17 | 6 | 10 | 1 | +347 / -147 | 0% |
| prisma | `seed` | 3 | 2 | 1 | 0 | +477 / -17 | 0% |
| api | `jobs` | 66 | 2 | 0 | 64 | +441 / -26 | 0% |
| web | `services` | 33 | 2 | 1 | 30 | +436 / -31 | 0% |
| api-test | `nodes` | 14 | 10 | 2 | 0 | +84 / -381 | 14.3% |
| cli | `(root)` | 41 | 13 | 11 | 10 | +211 / -251 | 22.6% |
| api | `openapi` | 18 | 3 | 2 | 13 | +288 / -162 | 0% |
| api-test | `fixtures` | 44 | 3 | 0 | 39 | +89 / -320 | 40% |
| api-test | `onboarding` | 4 | 1 | 3 | 0 | +281 / -128 | 0% |
| web | `config` | 5 | 3 | 2 | 0 | +264 / -140 | 0% |
| web | `hooks` | 72 | 4 | 1 | 63 | +357 / -33 | 44.4% |
| web | `types` | 1 | 1 | 0 | 0 | +337 / -47 | 0% |
| api-test | `about` | 2 | 1 | 1 | 0 | +155 / -188 | 0% |
| scripts | `(root)` | 16 | 3 | 12 | 0 | +61 / -281 | 6.3% |
| packages | `shared` | 51 | 5 | 0 | 46 | +236 / -96 | 0% |
| api-test | `(root)` | 16 | 5 | 6 | 0 | +140 / -163 | 31.3% |
| api-test | `prisma` | 14 | 1 | 13 | 0 | +163 / -108 | 0% |
| api | `(root)` | 5 | 3 | 2 | 0 | +169 / -85 | 0% |
| infra | `otel` | 3 | 1 | 1 | 1 | +16 / -182 | 0% |
| web | `pages` | 37 | 2 | 1 | 33 | +127 / -32 | 25% |
| infra | `compose` | 16 | 7 | 5 | 1 | +35 / -104 | 20% |
| web | `theme` | 5 | 3 | 0 | 2 | +104 / -17 | 0% |
| api | `config` | 2 | 1 | 1 | 0 | +62 / -36 | 0% |
| infra | `nginx` | 14 | 3 | 11 | 0 | +10 / -75 | 0% |
| api-test | `db-backup` | 10 | 3 | 7 | 0 | +27 / -56 | 0% |
| api-test | `auth` | 11 | 3 | 6 | 1 | +30 / -45 | 10% |
| api-test | `notifications` | 42 | 3 | 38 | 0 | +30 / -44 | 2.4% |
| web | `components/common` | 11 | 1 | 0 | 8 | +52 / -22 | 66.7% |
| api-test | `helpers` | 13 | 5 | 6 | 1 | +41 / -27 | 8.3% |
| web | `contexts` | 6 | 1 | 0 | 5 | +56 / -8 | 0% |
| api | `prisma` | 11 | 3 | 8 | 0 | +7 / -42 | 0% |
| api-test | `mocks` | 5 | 3 | 0 | 0 | +7 / -40 | 40% |
| github | `(root)` | 3 | 1 | 1 | 0 | +24 / -19 | 33.3% |
| api-test | `broadcasts` | 5 | 2 | 3 | 0 | +1 / -34 | 0% |
| cli | `init` | 3 | 2 | 1 | 0 | +8 / -23 | 0% |
| api-test | `errors` | 1 | 1 | 0 | 0 | +0 / -29 | 0% |
| api-test | `maintenance` | 2 | 2 | 0 | 0 | +11 / -16 | 0% |
| api-test | `openapi` | 3 | 3 | 0 | 0 | +13 / -12 | 0% |
| web | `utils` | 14 | 1 | 0 | 12 | +10 / -0 | 50% |
| api-test | `test-auth` | 1 | 1 | 0 | 0 | +0 / -8 | 0% |
| prisma | `(root)` | 3 | 1 | 1 | 0 | +1 / -3 | 33.3% |
| android | `(root)` | 7 | 0 | 7 | 0 | +0 / -0 | 0% |
| android | `app` | 15 | 0 | 15 | 0 | +0 / -0 | 0% |
| android | `gradle` | 3 | 0 | 3 | 0 | +0 / -0 | 0% |
| android | `scripts` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| api | `about` | 8 | 0 | 0 | 8 | +0 / -0 | n/a |
| api | `ai` | 51 | 0 | 0 | 51 | +0 / -0 | n/a |
| api | `allowlist` | 9 | 0 | 0 | 9 | +0 / -0 | n/a |
| api | `app-registrations` | 21 | 0 | 21 | 0 | +0 / -0 | 0% |
| api | `ask` | 54 | 0 | 0 | 54 | +0 / -0 | n/a |
| api | `auth` | 30 | 0 | 0 | 30 | +0 / -0 | n/a |
| api | `credentials` | 5 | 0 | 0 | 5 | +0 / -0 | n/a |
| api | `db-backup` | 48 | 0 | 0 | 48 | +0 / -0 | n/a |
| api | `device-auth` | 18 | 0 | 0 | 18 | +0 / -0 | n/a |
| api | `doctor` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| api | `email` | 51 | 0 | 0 | 51 | +0 / -0 | n/a |
| api | `examples` | 30 | 0 | 30 | 0 | +0 / -0 | 0% |
| api | `export` | 4 | 0 | 0 | 4 | +0 / -0 | n/a |
| api | `graph` | 246 | 0 | 0 | 246 | +0 / -0 | n/a |
| api | `health` | 5 | 0 | 0 | 5 | +0 / -0 | n/a |
| api | `identity-extensions` | 6 | 0 | 6 | 0 | +0 / -0 | 0% |
| api | `nodes` | 36 | 0 | 0 | 36 | +0 / -0 | n/a |
| api | `notes` | 86 | 0 | 0 | 86 | +0 / -0 | n/a |
| api | `notifications` | 65 | 0 | 0 | 65 | +0 / -0 | n/a |
| api | `onboarding` | 8 | 0 | 1 | 7 | +0 / -0 | 0% |
| api | `pat` | 8 | 0 | 0 | 8 | +0 / -0 | n/a |
| api | `platform` | 85 | 0 | 85 | 0 | +0 / -0 | 0% |
| api | `platform-extensions` | 64 | 0 | 64 | 0 | +0 / -0 | 0% |
| api | `search` | 39 | 0 | 0 | 39 | +0 / -0 | n/a |
| api | `settings` | 31 | 0 | 8 | 23 | +0 / -0 | 0% |
| api | `storage` | 35 | 0 | 0 | 35 | +0 / -0 | n/a |
| api | `test-auth` | 7 | 0 | 0 | 7 | +0 / -0 | n/a |
| api | `transcription` | 26 | 0 | 0 | 26 | +0 / -0 | n/a |
| api | `transcripts` | 116 | 0 | 0 | 116 | +0 / -0 | n/a |
| api | `user-data` | 10 | 0 | 0 | 10 | +0 / -0 | n/a |
| api | `users` | 11 | 0 | 0 | 11 | +0 / -0 | n/a |
| api-test | `ai` | 24 | 0 | 21 | 3 | +0 / -0 | 0% |
| api-test | `android-app` | 4 | 0 | 4 | 0 | +0 / -0 | 0% |
| api-test | `ask` | 11 | 0 | 0 | 11 | +0 / -0 | n/a |
| api-test | `conformance` | 2 | 0 | 2 | 0 | +0 / -0 | 0% |
| api-test | `credentials` | 5 | 0 | 5 | 0 | +0 / -0 | 0% |
| api-test | `device-auth` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| api-test | `doctor` | 5 | 0 | 5 | 0 | +0 / -0 | 0% |
| api-test | `email` | 2 | 0 | 2 | 0 | +0 / -0 | 0% |
| api-test | `event-bus` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| api-test | `examples` | 66 | 0 | 66 | 0 | +0 / -0 | 0% |
| api-test | `exports` | 3 | 0 | 3 | 0 | +0 / -0 | 0% |
| api-test | `graph` | 57 | 0 | 0 | 57 | +0 / -0 | n/a |
| api-test | `identity` | 2 | 0 | 2 | 0 | +0 / -0 | 0% |
| api-test | `notes` | 20 | 0 | 0 | 20 | +0 / -0 | n/a |
| api-test | `ontology` | 8 | 0 | 0 | 8 | +0 / -0 | n/a |
| api-test | `organizations` | 5 | 0 | 5 | 0 | +0 / -0 | 0% |
| api-test | `platform` | 7 | 0 | 7 | 0 | +0 / -0 | 0% |
| api-test | `rbac` | 4 | 0 | 2 | 0 | +0 / -0 | 50% |
| api-test | `retention` | 2 | 0 | 2 | 0 | +0 / -0 | 0% |
| api-test | `sharing` | 12 | 0 | 12 | 0 | +0 / -0 | 0% |
| api-test | `telemetry` | 11 | 0 | 11 | 0 | +0 / -0 | 0% |
| api-test | `tenancy` | 8 | 0 | 8 | 0 | +0 / -0 | 0% |
| api-test | `transcripts` | 10 | 0 | 0 | 10 | +0 / -0 | n/a |
| api-test | `user-data` | 6 | 0 | 6 | 0 | +0 / -0 | 0% |
| cli | `__fixtures__` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| github | `ISSUE_TEMPLATE` | 4 | 0 | 1 | 0 | +0 / -0 | 75% |
| github | `e2e` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| infra | `(root)` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| packages | `(root)` | 4 | 0 | 4 | 0 | +0 / -0 | 0% |
| packages | `platform-api` | 1787 | 0 | 1787 | 0 | +0 / -0 | 0% |
| packages | `platform-cli` | 352 | 0 | 352 | 0 | +0 / -0 | 0% |
| packages | `platform-contract` | 146 | 0 | 146 | 0 | +0 / -0 | 0% |
| packages | `platform-db` | 152 | 0 | 152 | 0 | +0 / -0 | 0% |
| packages | `platform-infra` | 113 | 0 | 113 | 0 | +0 / -0 | 0% |
| packages | `platform-web` | 915 | 0 | 915 | 0 | +0 / -0 | 0% |
| prisma | `catalog` | 3 | 0 | 3 | 0 | +0 / -0 | 0% |
| prisma | `fragments` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| prisma | `migrations` | 60 | 0 | 23 | 22 | +0 / -0 | 39.5% |
| prisma | `schema.prisma` | 12 | 0 | 11 | 1 | +0 / -0 | 0% |
| scripts | `platform-adoption` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| stack-agent | `(root)` | 7 | 0 | 7 | 0 | +0 / -0 | 0% |
| web | `components/admin` | 23 | 0 | 0 | 23 | +0 / -0 | n/a |
| web | `components/ai` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| web | `components/ask` | 16 | 0 | 0 | 16 | +0 / -0 | n/a |
| web | `components/auth` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| web | `components/datatable` | 44 | 0 | 0 | 44 | +0 / -0 | n/a |
| web | `components/device-activation` | 5 | 0 | 0 | 5 | +0 / -0 | n/a |
| web | `components/graph` | 65 | 0 | 0 | 65 | +0 / -0 | n/a |
| web | `components/home` | 16 | 0 | 1 | 15 | +0 / -0 | 0% |
| web | `components/library` | 7 | 0 | 0 | 7 | +0 / -0 | n/a |
| web | `components/notes` | 26 | 0 | 0 | 26 | +0 / -0 | n/a |
| web | `components/notifications` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| web | `components/onboarding` | 5 | 0 | 0 | 5 | +0 / -0 | n/a |
| web | `components/pwa` | 2 | 0 | 0 | 2 | +0 / -0 | n/a |
| web | `components/search` | 3 | 0 | 0 | 3 | +0 / -0 | n/a |
| web | `components/settings` | 11 | 0 | 0 | 11 | +0 / -0 | n/a |
| web | `components/transcripts` | 20 | 0 | 0 | 20 | +0 / -0 | n/a |
| web | `components/upload` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| web | `components/user` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| web | `identity` | 3 | 0 | 3 | 0 | +0 / -0 | 0% |
| web | `jobs` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| web | `nodes` | 1 | 0 | 1 | 0 | +0 / -0 | 0% |
| web | `platform` | 12 | 0 | 12 | 0 | +0 / -0 | 0% |
| web | `platform-extensions` | 38 | 0 | 38 | 0 | +0 / -0 | 0% |

## Most changed files (top 50)

| File | Lines +/- |
|---|---|
| `apps/cli/src/deploy/install.test.ts` | +1220 / -556 |
| `apps/cli/src/commands/deploy.ts` | +930 / -773 |
| `apps/cli/src/deploy/update.test.ts` | +878 / -518 |
| `apps/web/src/__tests__/pages/HomePage.test.tsx` | +1038 / -289 |
| `apps/cli/src/deploy/install.ts` | +573 / -746 |
| `apps/cli/src/commands/deploy.test.ts` | +785 / -461 |
| `apps/cli/src/tui/screens/deploy/install.tsx` | +915 / -303 |
| `apps/cli/src/deploy/update.ts` | +458 / -675 |
| `apps/cli/src/tui/screens/deploy/install-model.ts` | +955 / -127 |
| `apps/cli/src/deploy/proxy.test.ts` | +513 / -477 |
| `apps/cli/src/deploy/uninstall.test.ts` | +482 / -465 |
| `apps/cli/src/deploy/uninstall.ts` | +715 / -222 |
| `apps/cli/src/deploy/env-wizard.test.ts` | +722 / -161 |
| `apps/cli/src/deploy/checks/host.test.ts` | +485 / -358 |
| `apps/web/src/__tests__/mocks/handlers.ts` | +450 / -314 |
| `apps/cli/src/deploy/proxy.ts` | +294 / -435 |
| `apps/cli/src/node/node-engine.test.ts` | +5 / -705 |
| `apps/cli/src/tui/screens/deploy/update.tsx` | +477 / -187 |
| `apps/cli/src/deploy/layout.test.ts` | +448 / -109 |
| `apps/cli/src/deploy/version-step.test.ts` | +257 / -289 |
| `apps/cli/src/deploy/about.ts` | +478 / -62 |
| `apps/web/src/__tests__/App.test.tsx` | +213 / -311 |
| `apps/api/test/storage/storage.integration.spec.ts` | +328 / -187 |
| `apps/cli/src/deploy/env-wizard.ts` | +389 / -97 |
| `apps/web/src/App.tsx` | +180 / -270 |
| `apps/cli/src/deploy/deploy-info.test.ts` | +363 / -83 |
| `apps/api/src/jobs/handlers/README.md` | +436 / -8 |
| `.github/workflows/deploy-e2e.yml` | +269 / -162 |
| `apps/cli/src/deploy/checks/host.ts` | +273 / -158 |
| `apps/web/src/pages/Admin/AboutPage.tsx` | +425 / -2 |
| `apps/cli/src/deploy/testing/fake-vps.ts` | +156 / -270 |
| `apps/cli/src/deploy/repo.test.ts` | +359 / -53 |
| `apps/api/test/onboarding/onboarding.integration.spec.ts` | +281 / -128 |
| `apps/cli/src/deploy/about.test.ts` | +337 / -64 |
| `apps/cli/src/deploy/checks/tls.ts` | +41 / -358 |
| `apps/cli/src/deploy/checks/external.test.ts` | +207 / -188 |
| `apps/web/src/types/index.ts` | +337 / -47 |
| `apps/cli/src/tui/screens/deploy/doctor.tsx` | +188 / -191 |
| `apps/web/src/services/api.ts` | +356 / -18 |
| `apps/cli/src/deploy/adopt.test.ts` | +309 / -61 |
| `apps/api/prisma/seed-data.ts` | +352 / -11 |
| `apps/cli/src/tui/screens/deploy/update.test.ts` | +248 / -110 |
| `apps/api/test/fixtures/test-data.factory.ts` | +72 / -284 |
| `apps/cli/src/deploy/deploy-info.ts` | +252 / -93 |
| `apps/api/test/about/about.integration.spec.ts` | +155 / -188 |
| `apps/api/src/common/schemas/settings.schema.ts` | +191 / -130 |
| `apps/cli/src/deploy/app-version.test.ts` | +124 / -194 |
| `apps/cli/src/deploy/version-step.ts` | +225 / -93 |
| `.github/workflows/ci.yml` | +12 / -296 |
| `apps/web/src/__tests__/config/destinations.test.ts` | +213 / -94 |

## Migrations

Matched by normalised SQL first, then by the name after the 14-digit timestamp.

| Base | App | Shared | Renamed | Same name, different SQL | Base-only | App-only |
|---|---|---|---|---|---|---|
| 37 | 36 | 14 | 0 | 0 | 23 | 22 |

Base-only:

- `20260908120000_add_job_claim_token`
- `20260926034919_add_ai_platform`
- `20260927000000_revoke_viewer_ai_use`
- `20260927120000_add_user_credentials`
- `20260927130000_add_device_session_credential_link`
- `20260928100000_add_worker_node_vitals`
- `20260930120000_add_job_trace_context`
- `20261006120000_add_retention_created_at_indexes`
- `20261007141244_add_organizations`
- `20261007161956_split_system_org_roles`
- `20261007202337_org_scoped_rls`
- `20261007222406_add_groups`
- `20261008000859_add_grants`
- `20261008012052_add_org_settings`
- `20261008041856_add_org_credentials`
- `20261008052119_add_jobs_org_id`
- `20261008052120_add_jobs_org_id_status_index`
- `20261008080749_add_broadcast_target_org`
- `20261008120000_add_android_app`
- `20261013115831_open_job_reason`
- `20261013154013_ai_usage_feature`
- `20261013195500_add_app_metadata`
- `20261013214001_open_sharing_vocabularies`

App-only:

- `20260914120000_add_storage_part_size_and_managed_by`
- `20260914130000_add_transcripts`
- `20260914140000_add_notes`
- `20260914150000_add_user_ai_credentials`
- `20260915120000_add_search_vectors`
- `20260915130000_add_search_embeddings`
- `20260915210000_add_note_title_source`
- `20260918120000_add_allowlist_reminder_tracking`
- `20260923120000_add_note_generation_context_snapshot`
- `20260923130000_add_user_hidden_note_templates`
- `20260923140000_add_transcript_speaker_identities`
- `20260923150000_transcript_name_checks`
- `20260923160000_add_note_body_format`
- `20260923170000_add_note_version_body_format`
- `20260926012548_add_knowledge_graph`
- `20260926030000_fix_kg_relations_valid_precision_chk`
- `20260926030100_add_transcript_recorded_at`
- `20260926030200_kg_evidence_invariant`
- `20260926040000_add_kg_graph_layouts`
- `20260926050000_add_ask_conversations`
- `20260926231512_add_kg_exports`
- `20260927050000_ai_token_limits_follow_model`

## Prisma models

Base models present in the app: 26 of 41. Total models in the app: 61.

- Missing from the app: `AiModel`, `AiRun`, `AiUsageEvent`, `AndroidAppRelease`, `Grant`, `Group`, `GroupInvite`, `GroupMember`, `Invite`, `Membership`, `OrgCredential`, `OrgSettings`, `Organization`, `UserAiKey`, `UserCredential`
- App-only: `AskConversation`, `AskMessage`, `KgAttributeDef`, `KgDistinctPair`, `KgEntity`, `KgEntityAlias`, `KgEntityDigest`, `KgEntityView`, `KgEvidence`, `KgExport`, `KgGraphLayout`, `KgItem`, `KgMention`, `KgMerge`, `KgProposal`, `KgProposalItem`, `KgRelation`, `Note`, `NoteExport`, `NoteGeneration`, `NoteTemplate`, `NoteVersion`, `SearchChunk`, `SearchEmbedding`, `SearchIndexState`, `Transcript`, `TranscriptExport`, `TranscriptNameCheck`, `TranscriptNameSuggestion`, `TranscriptSegment`, `TranscriptShare`, `TranscriptSpeaker`, `TranscriptVersion`, `UserAiCredential`, `UserHiddenNoteTemplate`

Shared models whose fields differ:

| Model | Fields added in the app | Fields removed in the app |
|---|---|---|
| `AllowedEmail` | `lastReminderAt`, `reminderCount` | none |
| `AuditEvent` | none | `org`, `orgId` |
| `DeviceCode` | none | `collectedAt`, `credentialExpiresAt`, `org`, `orgId`, `pat`, `patId`, `refreshTokens`, `revokedAt` |
| `Job` | `askMessage`, `kgExport`, `kgProposal`, `noteExport`, `noteGeneration`, `transcriptExport`, `transcriptNameCheck` | `claimToken`, `org`, `orgId`, `traceContext` |
| `NotificationBroadcast` | none | `targetOrg`, `targetOrgId` |
| `Permission` | none | `scope` |
| `PersonalAccessToken` | none | `deviceCodes`, `org`, `orgId` |
| `PushSubscription` | none | `platform` |
| `RefreshToken` | none | `deviceCode`, `deviceCodeId`, `org`, `orgId` |
| `Role` | none | `invites`, `memberships`, `scope` |
| `StorageObject` | `kgEvidenceImports`, `kgExportFiles`, `managedBy`, `noteExportFiles`, `notesAsSourceObject`, `partSize`, `transcriptExportFiles`, `transcriptVersionSnapshots`, `transcriptsAsPlayback`, `transcriptsAsRawResult`, `transcriptsAsSource` | `org`, `orgId` |
| `StorageObjectChunk` | none | `org`, `orgId` |
| `User` | `aiCredentials`, `askConversations`, `hiddenNoteTemplates`, `kgAttributeDefs`, `kgDistinctPairs`, `kgEntities`, `kgEntityAliases`, `kgEntityDigests`, `kgEntityViews`, `kgEvidence`, `kgExports`, `kgGraphLayouts`, `kgItems`, `kgMentions`, `kgMerges`, `kgProposals`, `kgRelations`, `noteExportsRequested`, `noteTemplatesOwned`, `noteVersionsAuthored`, `notes`, `searchIndexStates`, `transcriptExportsRequested`, `transcriptNameChecksRequested`, `transcriptNameSuggestionsDecided`, `transcriptSegmentEdits`, `transcriptSharesGranted`, `transcriptSharesReceived`, `transcriptVersionsAuthored`, `transcripts` | `aiKeys`, `aiModelsUpdated`, `aiRuns`, `aiUsageEvents`, `androidAppReleases`, `grantsGiven`, `grantsReceived`, `grantsRevoked`, `groupInvitesClaimed`, `groupInvitesSent`, `groupMembersAdded`, `groupMemberships`, `groupsCreated`, `invitesAccepted`, `invitesSent`, `memberships`, `metadata`, `orgCredentialUpdates`, `orgSettingsUpdates`, `organizationsCreated`, `userCredentials` |
| `WorkerNode` | none | `lastVitals`, `lastVitalsAt` |

## Zero-drift modules

Modules where every file exists on both sides and is identical or normalised-identical: the candidates for early adoption.

- api-test: `health` (1 files)
- api-test: `users` (1 files)

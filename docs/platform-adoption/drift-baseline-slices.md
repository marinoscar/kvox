# Platform drift report

Generated 2026-10-14T23:17:56.950Z by `scripts/platform-drift.mjs` (schema 1).

| | Root | Commit |
|---|---|---|
| Base | `EnterpriseAppBase (slice view)` | not a git checkout |
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
| api | `apps/api/src` | 914 | 17 | 13 | 234 | 650 | 870 | +6616 / -8744 | 3.3% |

## Modules by changed lines

| Area | Module | Files | Modified | Base-only | App-only | Lines +/- | Identical to base |
|---|---|---|---|---|---|---|---|
| api | `notifications` | 99 | 40 | 34 | 24 | +1110 / -1500 | 1.3% |
| api | `db-backup` | 72 | 27 | 24 | 21 | +806 / -1221 | 0% |
| api | `email` | 68 | 26 | 17 | 23 | +716 / -790 | 4.4% |
| api | `auth` | 61 | 16 | 31 | 9 | +319 / -1089 | 9.6% |
| api | `jobs` | 102 | 27 | 36 | 32 | +403 / -873 | 10% |
| api | `storage` | 95 | 21 | 60 | 13 | +723 / -515 | 1.2% |
| api | `user-data` | 33 | 4 | 23 | 6 | +613 / -515 | 0% |
| api | `settings` | 50 | 5 | 27 | 18 | +755 / -372 | 0% |
| api | `nodes` | 55 | 24 | 19 | 12 | +292 / -509 | 0% |
| api | `device-auth` | 18 | 11 | 0 | 1 | +122 / -356 | 35.3% |
| api | `onboarding` | 20 | 3 | 13 | 4 | +216 / -197 | 0% |
| api | `about` | 14 | 3 | 6 | 5 | +165 / -151 | 0% |
| api | `users` | 12 | 5 | 1 | 4 | +53 / -194 | 25% |
| api | `pat` | 8 | 5 | 0 | 2 | +47 / -137 | 16.7% |
| api | `openapi` | 16 | 7 | 0 | 7 | +35 / -101 | 22.2% |
| api | `allowlist` | 10 | 4 | 1 | 3 | +114 / -14 | 28.6% |
| api | `ai` | 358 | 1 | 307 | 50 | +47 / -73 | 0% |
| api | `credentials` | 20 | 3 | 15 | 1 | +45 / -64 | 5.3% |
| api | `health` | 9 | 1 | 4 | 4 | +32 / -46 | 0% |
| api | `export` | 36 | 1 | 32 | 3 | +3 / -27 | 0% |
| api | `(root)` | 3 | 0 | 0 | 3 | +0 / -0 | n/a |
| api | `ask` | 54 | 0 | 0 | 54 | +0 / -0 | n/a |
| api | `common` | 47 | 0 | 0 | 47 | +0 / -0 | n/a |
| api | `config` | 1 | 0 | 0 | 1 | +0 / -0 | n/a |
| api | `graph` | 246 | 0 | 0 | 246 | +0 / -0 | n/a |
| api | `notes` | 86 | 0 | 0 | 86 | +0 / -0 | n/a |
| api | `prisma` | 3 | 0 | 0 | 3 | +0 / -0 | n/a |
| api | `search` | 39 | 0 | 0 | 39 | +0 / -0 | n/a |
| api | `test-auth` | 7 | 0 | 0 | 7 | +0 / -0 | n/a |
| api | `transcription` | 26 | 0 | 0 | 26 | +0 / -0 | n/a |
| api | `transcripts` | 116 | 0 | 0 | 116 | +0 / -0 | n/a |

## Most changed files (top 50)

| File | Lines +/- |
|---|---|
| `apps/api/src/auth/auth.service.ts` | +202 / -772 |
| `apps/api/src/storage/objects/objects.service.ts` | +358 / -237 |
| `apps/api/src/settings/user-settings/user-settings.service.ts` | +358 / -132 |
| `apps/api/src/db-backup/restore-preflight.service.ts` | +367 / -112 |
| `apps/api/src/settings/system-settings/system-settings.service.ts` | +321 / -154 |
| `apps/api/src/user-data/user-data.service.ts` | +174 / -278 |
| `apps/api/src/user-data/handlers/user-data-purge.handler.ts` | +335 / -39 |
| `apps/api/src/db-backup/db-backup-runner.service.ts` | +52 / -242 |
| `apps/api/src/email/email-settings.service.ts` | +87 / -206 |
| `apps/api/src/onboarding/onboarding.service.ts` | +164 / -93 |
| `apps/api/src/user-data/user-data.controller.ts` | +77 / -163 |
| `apps/api/src/device-auth/device-auth.service.ts` | +53 / -173 |
| `apps/api/src/notifications/index.ts` | +49 / -169 |
| `apps/api/src/about/about.service.ts` | +133 / -74 |
| `apps/api/src/db-backup/database-restore.service.ts` | +33 / -164 |
| `apps/api/src/email/index.ts` | +70 / -125 |
| `apps/api/src/users/users.service.ts` | +40 / -155 |
| `apps/api/src/email/templates/index.ts` | +141 / -53 |
| `apps/api/src/notifications/notifications.service.ts` | +32 / -159 |
| `apps/api/src/jobs/job-terminal.service.ts` | +41 / -147 |
| `apps/api/src/notifications/broadcasts/broadcasts.service.ts` | +28 / -160 |
| `apps/api/src/jobs/handlers/README.md` | +32 / -148 |
| `apps/api/src/notifications/channels/browser-notification.channel.ts` | +144 / -14 |
| `apps/api/src/storage/objects/objects.controller.ts` | +88 / -65 |
| `apps/api/src/notifications/notification-stream.service.ts` | +2 / -150 |
| `apps/api/src/notifications/notification-events.ts` | +140 / -11 |
| `apps/api/src/db-backup/dto/db-backup-restore.dto.ts` | +107 / -43 |
| `apps/api/src/notifications/broadcasts/broadcasts.controller.ts` | +30 / -113 |
| `apps/api/src/auth/auth.controller.ts` | +50 / -91 |
| `apps/api/src/notifications/dto/push-test.dto.ts` | +115 / -25 |
| `apps/api/src/pat/pat.service.ts` | +30 / -108 |
| `apps/api/src/notifications/push-config.service.ts` | +78 / -56 |
| `apps/api/src/notifications/broadcasts/handlers/broadcast-chunk.handler.ts` | +18 / -110 |
| `apps/api/src/device-auth/README.md` | +13 / -110 |
| `apps/api/src/notifications/broadcasts/handlers/broadcast-start.handler.ts` | +17 / -106 |
| `apps/api/src/db-backup/db-backup-admin.service.ts` | +18 / -103 |
| `apps/api/src/storage/providers/s3/s3-storage.provider.ts` | +73 / -48 |
| `apps/api/src/ai/ai.module.ts` | +47 / -73 |
| `apps/api/src/db-backup/schedule.util.ts` | +10 / -107 |
| `apps/api/src/jobs/dto/job-insights.dto.ts` | +74 / -43 |
| `apps/api/src/jobs/job.worker.ts` | +5 / -110 |
| `apps/api/src/onboarding/onboarding.controller.ts` | +32 / -83 |
| `apps/api/src/nodes/dto/node-admin.dto.ts` | +6 / -105 |
| `apps/api/src/storage/processing/object-processing.service.ts` | +49 / -58 |
| `apps/api/src/email/templates/layout.ts` | +38 / -68 |
| `apps/api/src/email/providers/ses-email.provider.ts` | +55 / -49 |
| `apps/api/src/nodes/nodes.controller.ts` | +17 / -82 |
| `apps/api/src/allowlist/allowlist.service.ts` | +79 / -12 |
| `apps/api/src/notifications/broadcasts/dto/broadcast-response.dto.ts` | +61 / -30 |
| `apps/api/src/nodes/nodes.service.ts` | +27 / -63 |

## Zero-drift modules

Modules where every file exists on both sides and is identical or normalised-identical: the candidates for early adoption.

None.

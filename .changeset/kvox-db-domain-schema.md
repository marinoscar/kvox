---
"@marinoscar/kvox-db": minor
---

The domain schema moves into `@marinoscar/kvox-db`: the five fragments (`schema/kvox.{transcripts,notes,search,graph,ask}.prisma`), the 18 domain migrations byte for byte with `migrations/manifest.json`, the raw-SQL index, extension and schema-object inventories, and the `kvox-db` command (`sync`, `check`, `check --database`, `promote`) that installs them into a host app with `prisma/kvox.lock`.

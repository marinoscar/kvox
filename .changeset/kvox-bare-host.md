---
"@marinoscar/kvox-db": minor
"@marinoscar/kvox-api": minor
---

Fixes found by the bare-host smoke app (`examples/bare-host`, a host that installs the packed tarballs and is not the web edition). `@marinoscar/kvox-db` gains the migration `20261016120000_transcripts_org_id` (byte for byte the web app's, which `kvox-db sync` adopts): the transcripts fragment already declared the NOT NULL `org_id` column, but a host with no domain history never got it, so no transcript could be created. `organizations` joins `users`, `storage_objects` and `jobs` as a host table a domain migration may reference (`KVOX_HOST_TABLES`, `KVOX_HOST_MODELS`). `@marinoscar/kvox-api`: resolving a provider a host registers through `extraProviders` no longer fails for want of a stored settings block; the PDF exporters' exported drawing helpers take the new `KvoxPdfDocument` type (an `object`, from `core`) instead of pdfkit's, so the package's declaration files typecheck with `skipLibCheck: false` in a host that left the optional `pdfkit` peer out; and the `ai` system settings namespace the slices read, the global `ZodValidationPipe` and the host's upload-completion route are documented as host duties.

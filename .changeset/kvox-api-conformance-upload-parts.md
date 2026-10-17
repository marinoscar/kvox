---
"@marinoscar/kvox-api": minor
---

`describeKvoxPortsConformance` gains the optional object-store hook `uploadParts(init, size)` on `KvoxObjectStoreUnderTest`. The rule "the onUploaded handler fires once per completed upload" sealed an upload nothing had been sent to, which only an in-memory fake accepts: a store that checks its parts at `completeUpload` (the bare host's filesystem store, S3) refused it with `Part 1 of 1 has not been uploaded`. A host that supplies the hook has the kit PUT the bytes to the signed part URLs first; without it the rule behaves as before, so existing factories are unaffected. Found by running the kit against the bare host's local ports (`examples/bare-host/test/ports-conformance.test.ts`, now part of the `bare-host` CI job on both database legs).

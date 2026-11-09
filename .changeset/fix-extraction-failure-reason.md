---
"@marinoscar/kvox-contract": patch
"@marinoscar/kvox-api": patch
"@marinoscar/kvox-ai": patch
"@marinoscar/kvox-web": patch
---

A failed graph extraction now says why (#759). The proposal's `stats.failure.errorClass` gains `network`, `timeout` and `unavailable` (the provider could not be reached, did not answer in time, or answered 5xx) with a fixed, safe sentence each; an unrecognised failure still reads "unexpected error" but now carries the job id as a reference, and no thrown message reaches the user. `KvoxAiError` carries an optional `transient` reason (`unreachable`, `network`, `timeout`, `provider_unavailable`), set by `toKvoxAiError` from the provider adapter's transport detail and the cause chain's system code (`EAI_AGAIN`, `ECONNRESET`, ...). `kg.extract` retries a request that never left the host (DNS failure, connection refused) with a back-off of 2, 5 and 15 seconds; a reset or timeout mid-call is not retried because it may have been billed.

# download

The one verified file download that `prepareCopilotRuntime` (`copilot`) and `downloadLocalEmbeddingModel` (`local-embeddings`) share (issue #660). Internal: no entry point exports it.

## Purpose and scope

`downloadVerifiedFile` fetches one file and installs it only if its SHA-256 matches: https only, no credentials or port in the URL, an EXACT host match on the first URL and on EVERY redirect hop (redirects are followed by hand), at most `MAX_REDIRECTS` (5) hops, streaming to the destination while hashing, a `maxBytes` cap (Content-Length first, then the running total), the hash compared before the file is handed back (a mismatch deletes it), cancellation through an `AbortSignal` and progress. Failures go through the caller's `VerifiedDownloadErrors` factory, so each caller keeps its own error type, messages and `details.check` codes. `assertAllowedUrl` and `fetchWithAllowedHosts` are the URL check and the redirect-safe fetch on their own (the Copilot manifest request uses them).

## Entry point

None. `copilot` and `local-embeddings` import it through `src/download/index.ts`; the package root does not re-export it.

## Peer dependencies

None (`node:crypto`, `node:fs/promises`). It imports no other slice.

## Configuration

None. The caller passes the allowed hosts, the byte cap, the destination and the error factory on every call.

## Extension-point catalog

None.

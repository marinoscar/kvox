# errors

The one translation from whatever a runtime or provider threw into the port's `KvoxAiError`.

## Purpose and scope

`toKvoxAiError(error, { feature, inJob })`: a `KvoxAiError` passes through, a platform `AiError` is classified by its code and whether the call ran inside a queue job (the table in the source header), anything else is `timeout` or `other`. `refusalFor(readiness)`: the port error for a feature whose readiness says it cannot run. `scrub(text)`: the key-shaped-string backstop every message passes through. `isErrorLike(value)`: an `Error` or an error-shaped value such as a `DOMException`.

Status: the composition of the web edition's two former hops (`mapAiError` in `apps/api/src/ai-port/kvox-ai-errors.ts`, then the port adapter's `toKvoxAiError`), proven equal by the frozen table `test/fixtures/error-parity.v1.json` (issue #579, PR 2).

## Entry point

`@marinoscar/kvox-ai` (the package root re-exports this slice).

## Peer dependencies

`@marinoscar/kvox-api` (`KvoxAiError` from `@marinoscar/kvox-api/ports`) and `@marinoscar/platform-api` (only `@marinoscar/platform-api/ai`, for `AiError`). It imports the `types` and `features` slices. No platform job class and no Nest exception: a host runtime translates its own exceptions before they leave it.

## Configuration

None.

## Extension-point catalog

None.

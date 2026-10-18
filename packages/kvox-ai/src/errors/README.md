# errors

The one translation from whatever a runtime or provider threw into the port's `KvoxAiError`.

## Purpose and scope

`toKvoxAiError(error, { feature, inJob })`: a `KvoxAiError` passes through, a provider `AiError` (the lean class or the web host's lookalike, see `isAiError`) is classified by its code and whether the call ran inside a queue job (the table in the source header), anything else is `timeout` or `other`. `refusalFor(readiness)`: the port error for a feature whose readiness says it cannot run. `scrub(text)`: the key-shaped-string backstop every message passes through. `isErrorLike(value)`: an `Error` or an error-shaped value such as a `DOMException`. `isAiError(value)`: structural check for an `AiError` by class or by shape (an `Error` named `AiError` with a known code and `getResponse`), so the platform-api copy of the class that the web host's `AiService` throws is still classified until platform-api re-exports the lean one.

Status: the composition of the web edition's two former hops (the former `mapAiError` and the port adapter's `toKvoxAiError`, both deleted from `apps/api`), proven equal by the frozen table `test/fixtures/error-parity.v1.json` (issue #579).

## Entry point

`@marinoscar/kvox-ai` (the package root re-exports this slice).

## Peer dependencies

`@marinoscar/kvox-api` (`KvoxAiError` from `@marinoscar/kvox-api/ports`) and `@marinoscar/platform-ai-providers` (for `AiError`). It imports the `types` and `features` slices. No platform job class and no Nest exception: a host runtime translates its own exceptions before they leave it.

## Configuration

None.

## Extension-point catalog

None.

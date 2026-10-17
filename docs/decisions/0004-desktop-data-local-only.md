# ADR-0004: Desktop data stays on the device; AI is the only cloud egress

- Status: Accepted
- Date: 2026-10-17
- Related issues: epic #574, #583, #584, #587

## Context

KVox Desktop is a single-user, offline-first application. Users keep meeting transcripts and notes in it, so what leaves the machine must be small, listed and enforced.

## Decision

Documents, transcripts, notes, the graph and settings live under the user data folder. Documents are copied into a local vault. No upload path exists.

The only outbound traffic:

| Destination | When |
|---|---|
| The configured AI provider: OpenAI or an OpenAI-compatible base URL; GitHub Copilot when enabled | When a feature calls the model |
| GitHub Releases | Only if the user enables update checks (default off) |

Single user, no sign-in. The loopback server still requires a per-launch token, so other local processes and web pages cannot call it.

Exception, stated plainly: generating a note or extracting the graph sends that text to the AI provider. A `sensitive` PersonFact never leaves the device (a package invariant). Fully offline use is an OpenAI-compatible local model server (Ollama, LM Studio).

## Consequences

- Privacy claims are narrow and checkable: data stays local except text sent to the provider the user chose.
- No telemetry and no crash upload, so the team sees no field failures unless a user sends logs by hand.
- Update checks are opt-in, so users may run old versions.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Cloud sync of the data folder | Contradicts the local-only promise; no use case in v1. |
| Telemetry and crash upload | Same; logs stay local and the user shares them on request. |
| Update checks on by default | An outbound call the user did not ask for. |

## Enforcement

- Renderer CSP `connect-src http://127.0.0.1:*`.
- `session.webRequest` blocking in the window.
- A global undici dispatcher and an http(s) agent allowlist in the server process; blocked hosts are logged.
- No telemetry or crash-upload dependency (reviewed in dependency updates).
- Loopback token check on every request.

## Related issues

#583, #584, #587.

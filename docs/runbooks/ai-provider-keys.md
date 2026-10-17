# Runbook: AI Provider Keys and Note Generation

**Audience:** anyone who generates notes (adding and testing your own key —
Sections 1–3), and whoever administers this deployment's AI policy
(enabling AI, choosing models, diagnosing "AI is unavailable" reports —
Sections 4–6).
**Applies to:** epic #45's note-generation feature on the platform AI slice
(issues #473 to #477, epic #472) — `/settings/ai` (per-user keys),
`/admin/settings/ai` (deployment policy), `/admin/settings/ai/models` and
`/admin/settings/ai/usage`, and the `note.generate` pipeline behind
`POST /api/notes`.

This runbook does not re-derive the design — the two state machines, prompt
assembly and the token budget, the streaming contract, and the full privacy
statement of what leaves this deployment and under whose account are
[`docs/specs/notes.md`](../specs/notes.md). It covers what an operator or a
user actually does: save a key, prove it works, enable models, and tell apart
the handful of ways "generate a note" can fail. Moving a deployment from the
application's previous AI layer is a separate procedure:
[`ai-platform-migration.md`](ai-platform-migration.md).

Source of truth for every claim below:

- The platform AI slice, `@marinoscar/platform-api/ai`, mounted in
  `apps/api/src/platform/ai/`. Its routes are in the platform reference at
  `/api/docs`:
  - `GET /api/ai/keys`, `PUT` / `DELETE /api/ai/keys/:provider` and
    `POST /api/ai/keys/:provider/test` — the per-user key surface (`ai:use`),
    ownership-scoped and write-only.
  - `GET /api/ai/config` and `GET /api/admin/ai/config` — the platform's own
    probe and policy; `/api/admin/ai/models` and `/api/admin/ai/usage` — the
    catalogue and the usage report (`ai_config:read` / `:write`).
- `apps/api/src/ai-port/ai-tasks.controller.ts` /
  `ai-tasks.service.ts` — `GET /api/ai-tasks/config`, the one capability probe
  every client (and this runbook) reads to answer "is AI usable, and does
  *this* user have a key", and `GET` / `PUT /api/ai-tasks/settings`, the fields
  this application adds to the `ai` namespace.
- `apps/api/src/ai-port/ai-errors.ts` — the five-outcome taxonomy
  (`AiAuthError`, `AiInputError`, `AiRefusedError`, `AiBudgetError`,
  `RateLimitError`) and `isTerminalAiError`; `kvox-ai-errors.ts` maps the
  platform's `AiError` codes onto them.
- `packages/kvox-api/src/notes/handlers/note-generate.handler.ts` — the job that
  actually calls the provider: `profile: { maxAttempts: 1 }`, the
  per-user throttle key, and which failures return normally (terminal)
  versus rethrow (retryable/deferred).
- `apps/api/src/ai-port/ai-token-budget.ts` — `computeTokenBudget`, and
  `assertWithinBudget` in each caller, where a too-large prompt is refused with
  numbers, before any request is sent.
- `apps/web/src/config/userSettingsSections.tsx`,
  `apps/web/src/config/adminSections.tsx` and
  `apps/web/src/pages/Admin/AiSettingsPage.tsx` — the cards and the page this
  runbook walks through. The pages themselves are the platform's
  (`@marinoscar/platform-web/ai/ui`).
- `docs/specs/notes.md` §2.2 (error taxonomy), §2.8 (task routing and the
  `KvoxAi` call path), §3.3 (token budget), §6.4 (permission model), §9
  (privacy) — the design behind all of the above.

**There is no deployment-wide AI key under this design.** The key policy is
`byok`: every provider key belongs to an individual user, is billed to their
own provider account, and a user with no key has no AI features — the product
says so rather than spending anyone else's account on their behalf. Keep that in
mind throughout: an administrator cannot "just add a key for everyone," and every
failure mode in Section 6 that traces back to a bad key is that **specific
user's** key, never the deployment's.

---

## 1. Before you start

- **A per-user key needs `ai:use`**, an organization permission seeded to the
  Admin, Contributor and Viewer roles, and **AI must be switched on** for the
  deployment. While it is off, every `/api/ai/*` route answers `403` with
  `details.reason: "AI_DISABLED"`, and the `AI Provider` card is hidden.
- **The deployment policy needs `ai_config:read` / `ai_config:write`**
  (system scope, held by Admin) — the pair the platform AI controllers
  enforce, and the same pair on `GET` / `PUT /api/ai-tasks/settings`. It
  replaced `system_settings:read` / `:write` on the `AI` card in #477. The
  `AI` card stays visible while AI is off, because it is where an
  administrator switches AI on; `AI models`, `AI usage` and the user card are
  hidden until then.
- The provider this application's task routing uses is `openai`
  (`KVOX_AI_PROVIDER`). Decide which OpenAI endpoint this deployment will call
  before anyone saves a key against it: the provider slot's base URL is a
  setting, not a constant, so an enterprise gateway or a self-hosted
  OpenAI-compatible server works the same way a direct OpenAI endpoint does.
  The platform ships other provider slots; this application does not route
  tasks to them.

## 2. Adding and testing your own key

Visit `/settings/ai` (**AI Provider**, under user Settings — the platform's
`UserAiKeysPage`).

1. **Paste the key and save.** The page calls `PUT /api/ai/keys/openai` with
   `{ "apiKey": "sk-…" }`. The platform **verifies the key against the
   provider first**, computes the models it can reach, and only then stores it
   (encrypted). A rejected key answers `400` with
   `details.reason: "AI_KEY_INVALID"` and **nothing is stored**; an unreachable
   provider answers with its own error (for example `503`
   `AI_PROVIDER_UNAVAILABLE`), also storing nothing. Saving a second time for
   the same provider **replaces** the stored key; there is never a second row
   per `(userId, provider)`.
2. **Test it.** The page's **Test** action calls
   `POST /api/ai/keys/openai/test`. With a key typed into the box it probes that
   key for this call only and stores nothing; with the box blank it probes the
   key you already have stored and also refreshes that key's verification time,
   last error code and reachable models. No test response is generated, so a
   test never bills your provider account. See Section 3.
3. **Removing a key** is `DELETE /api/ai/keys/openai`, a dedicated, idempotent
   action (`204`, also when there was no key).
4. **Nothing about the key is ever shown back to you or anyone else.**
   `GET /api/ai/keys` returns a masked `hint` (`••••a1b2`), the verification
   time and the last error code, never the key — not to you, not to an
   administrator, not through any endpoint this application exposes. The
   platform `ai-secret-egress` conformance suite
   (`apps/api/test/ai-conformance.spec.ts`) proves it against the running
   application.

## 3. What each `test` failure means

`POST /api/ai/keys/:provider/test` **always answers HTTP 200**, whether the
probe succeeded or not — a refused probe is a successful diagnosis, and it is
the entire reason this endpoint exists. Read `success`, then each entry of
`checks` (`credentials` and `list_models`, each with a `status`, a `code` and a
`detail` sentence). `reachableModelCount` is how many enabled catalogue models
the key can use.

| `credentials` check | What it actually means | What to do |
|---|---|---|
| `passed` (`ok`) | The provider accepted the key. | Nothing on this check. Read `list_models` next. |
| `failed`, `AI_KEY_INVALID` | **The key is wrong, revoked or copied incompletely.** | Regenerate the key on the provider's own dashboard and paste the new one. |
| `failed`, `AI_RATE_LIMITED` | **Nothing is wrong with the key.** The provider rate-limited it. | Wait a moment and test again; check your usage and billing pages with the provider. |
| `failed`, `AI_PROVIDER_UNAVAILABLE` | The provider (or the configured base URL) could not be reached: DNS, TLS, connection refused or the probe timeout. | A network or configuration problem, not a key problem — check the deployment's outbound network access, or escalate to an administrator if the base URL was recently changed (Section 4). |
| `failed`, any other code | An unexpected response from the provider. | Read `detail`; it is most likely transient. Try again shortly. |
| `skipped`, `not_configured` | Nothing was attempted: no key was typed and none is stored. | Type a key, or save one first. |

| `list_models` check | What it means |
|---|---|
| `passed` | `reachableModelCount` catalogue models are reachable with this key. **`0` means the key works but no model an administrator enabled is available to it** — see Section 4, and the models list on `/settings/ai`. |
| `skipped`, `not_attempted` | The key was not accepted, so models were not listed. |

A `400` from `PUT` (not `success: false` from `test`) is a different thing
entirely: either the key failed verification (`AI_KEY_INVALID`) or the request
was malformed. A `403` with `AI_DISABLED` means AI is switched off for the
deployment, and a `403` without that reason means the account lacks `ai:use`.

## 4. Enabling AI and choosing models

Visit `/admin/settings/ai` (**AI**, in the admin **General** settings group,
`ai_config:read`; saving needs `ai_config:write`, and without it every control
is visible and disabled).

- **The master switch** is the platform's `ai.enabled`. While off, no
  completion is requested from any provider, for anyone, regardless of who has
  a key saved, and the platform routes answer `AI_DISABLED`.
- **The key policy** stays `byok` for this application. Do not enable an
  organization or deployment fallback key: the privacy statement in
  `docs/specs/notes.md` §9 and the AI rules in `AGENTS.md` both assume every
  call runs on its caller's own key.
- **The provider slot** (`openai`) is enabled here, with its optional base URL.
  Test it from the page before relying on it; the platform's provider test
  never echoes a key.
- **Which models are permitted** is the `ai_models` catalogue on
  `/admin/settings/ai/models` (`AI models`): an administrator enables the
  models users may call and the page shows each model's capabilities and
  limits. A model that is not enabled is never offered to a user, and the
  application's `defaultModel` and per-task models can only name an enabled one
  (`PUT /api/ai-tasks/settings` answers `400` with
  `details.reason: "model_not_permitted"` otherwise). The `structuredOutput` and
  `toolCalling` flags decide which connected-knowledge tasks a model can take.
  An empty list is a legal, deliberate state — "nothing is permitted" — and
  closes the feature by policy without touching the master switch.
- **This application's own sections**, at the bottom of the same page:
  *Connected knowledge* (`graphEnabled`, the switch that lets automatic graph
  extraction spend users' own keys; off by default), *Task models* (the model
  and reasoning effort per connected-knowledge task) and *Model limits* (the
  default model, `maxInputTokens` / `maxOutputTokens`, the request timeout, the
  reasoning effort and `maxDocumentBytes`). They share one Save and are written
  through `PUT /api/ai-tasks/settings`. `xhigh` runs as `high`, because the
  platform accepts no higher effort.
  - **`maxInputTokens` / `maxOutputTokens`** bound the assembled prompt and the
    completion, under the model's own context window; both are optional caps
    (empty means the model's own maximum governs) — see Section 6 for what a
    user sees when a note doesn't fit.
  - **`maxDocumentBytes`** bounds one uploaded source document (25 MB by
    default). It lives in this AI policy, not a storage setting: the reason to
    bound it is that every byte becomes input tokens on the *uploading user's
    own* vendor account, not disk space.
- **Usage** is on `/admin/settings/ai/usage` (`AI usage`): calls, tokens and
  cost across the deployment, grouped by user, model, provider or feature. It
  is how you see which feature (`note_generate`, `graph_extract`, ...) is
  spending.

There is no field anywhere on these pages for a deployment-wide credential
used as a fallback for users. If you're looking for a way to give the whole
deployment one shared key: there isn't one under this design — see the note at
the top of this runbook and `docs/specs/notes.md` §9.

## 5. What "AI is unavailable" looks like, from each side

Every client — the note-creation flow, the template picker, this runbook —
reads one endpoint to decide what to show: `GET /api/ai-tasks/config` (gated on
`notes:read`, seeded to all three roles, so every ordinary account can read it,
and deliberately outside the platform's `/api/ai/*` guard so it answers while AI
is off). Two independent booleans answer two independent questions:

| | `available` | `keyConfigured` |
|---|---|---|
| **What it describes** | The deployment: is AI enabled, is the provider slot on, is at least one model enabled. | **The calling user**, specifically: do *they* have a saved key for the provider. |
| **Who can make it true** | An administrator, via `/admin/settings/ai` and `/admin/settings/ai/models`. | Each individual user, via `/settings/ai`. |
| **If it's false** | Nothing works for *anyone*, no matter whose key is saved. | This *one user* sees the "set up your AI key" prompt instead of the feature — everyone else may be fine. |

They are deliberately independent — an administrator can finish configuring
policy while a given user still has no key of their own, and a user with a saved
key still gets nothing while no model is enabled. (The `AI Provider` card is
hidden while AI is switched off, so a key is saved after the switch is on.) **"AI is unavailable" is therefore never one diagnosis** —
ask which of the two is false:

- **From a user's perspective:** open `/settings/ai`. If there's no key
  saved (or `Test` fails per Section 3), that's `keyConfigured: false` —
  yours to fix. If the card is missing altogether, AI is off or the account
  lacks `ai:use`.
- **From an administrator's perspective:** open `/admin/settings/ai`. If the
  master switch is off, or no model is enabled, or every enabled model fails the
  token-ceiling math against `maxInputTokens` / `maxOutputTokens`, that's
  `available: false` — every user is blocked regardless of their own key, and
  only an administrator can fix it.

An administrator **cannot see whether any individual user's `keyConfigured`
is true** through the key routes — there is no admin listing of who has a key
saved, and the usage report shows spend, not keys. If a specific user reports
"AI is unavailable" and `/admin/settings/ai` looks correctly configured, the next
question is whether *that user* has saved and tested their own key (Section 2),
not whether the deployment is broken.

## 6. Diagnosing a failed generation

`note.generate` is `maxAttempts: 1` **by design** (see the Notes rule in
[`apps/api/AGENTS.md`](../../apps/api/AGENTS.md)) — nothing about this job
type auto-retries, ever, because a second attempt would call the provider
with the user's own key a second time and, completions being
non-deterministic, show them different text than the partial stream they
already watched fail. `POST /api/notes/{id}/regenerate` is the only retry
path, and it's a person pressing a button. So every failure below is
**terminal** from the queue's point of view — the note goes to `failed`,
and the fix is for a human to act, not for the job to try again on its own.

Tell the broad causes apart like this:

**A. A bad key (`errorClass: "auth"`).** The platform answered `AI_KEY_REQUIRED`
(the user has no key) or `AI_KEY_INVALID` (the provider rejected it), which the
job reports as `AiAuthError` — the identical failure Section 3's `test`
endpoint would have caught beforehand. Fix: the affected user re-saves their key
at `/settings/ai`, tests it, then regenerates the note.

**B. A token-ceiling refusal (`errorClass` is not set at all — this is a
400 at request time, before a job is even queued).** `assertWithinBudget`
(`ai-port/ai-token-budget.ts`, called by `NoteGenerationRequestService`) runs *before*
`POST /api/notes` or `POST /api/notes/{id}/regenerate` creates anything, so this
never shows up as a failed note in the note list — it's a 400 response naming the
actual numbers: "this source is approximately *N* tokens; this model allows *M*
for input with this template and output length." **Nothing is silently
truncated** — see `AiBudgetError`'s header in `ai-port/ai-errors.ts`; this is
deliberate, because a truncating "fix" would generate a note from *part* of
the source with nothing telling the user a paragraph vanished. Fix: shorten
the source, use a shorter template, pick a model with a larger context
window (if an administrator has enabled one), or ask an administrator to raise
`maxInputTokens` / `maxOutputTokens` if the deployment ceiling — not the
model's own window — is the binding constraint.

**C. A model or policy refusal (409 or 400 at request time).** The request
names something the deployment will not run: `ai_not_configured` (AI is off or
no model is enabled), `model_not_permitted` (the chosen model is not enabled),
`model_lacks_capability` (the model cannot do the task) or `graph_disabled`
(connected knowledge is off). Fix: an administrator on `/admin/settings/ai` or
`/admin/settings/ai/models`; for `model_not_permitted` on a note, the user picks
a model from the list `GET /api/ai-tasks/config` offers.

**D. A provider outage or transient failure (unclassified — thrown as a
plain `Error`, not one of the four domain classes).** A 5xx, a dropped
socket, a DNS failure, a response that doesn't match what the provider
documents (the platform's `AI_PROVIDER_UNAVAILABLE` and similar). `Job.lastError`
records what actually happened; the note goes to `failed` and the error is
rethrown so the failure is visible rather than silently reported as success.
Fix: check the provider's own status page, then use **Regenerate** — since this
class is genuinely transient, a second attempt (a human-initiated one, per the
`maxAttempts: 1` policy above) is likely to succeed once the provider recovers.

**E. A rate limit (`RateLimitError`, HTTP 429) is invisible, and that's
correct.** It never marks the note `failed` at all — the job is deferred
and retried automatically with backoff, on the **per-user** throttle key
(`aiProviderThrottleKey(userId)`), so one busy user's 429 never affects
anyone else's generation. If a note seems stuck `generating` for longer
than a few minutes, this is the most likely explanation; it will resolve on
its own once the provider's rate limit window passes. (Compare this to
Section 3's `test` probe reporting `AI_RATE_LIMITED` — that's the same
underlying provider state, diagnosed proactively instead of discovered
mid-generation.)

**F. The provider declined to answer (`errorClass: "refusal"`).** A
content-policy refusal or `content_filter` finish — the request was well-formed
and the provider chose not to complete it. This is deliberately a *different*
message from B and D: "the provider declined to answer this" is not the same news
as "this application asked for something invalid," even though both are terminal
and neither auto-retries. Fix: a different source, a different template, or
accept that this particular content will not generate.

**In short:** `auth` → the user's key. A 400 before a job exists → the
budget, with numbers. A 409 or 400 `model_*` / `ai_not_configured` → the
administrator's policy. `refusal` → the provider's content decision, not a
bug. Anything else thrown → check the provider's status, then regenerate.
A note that never leaves `generating` → almost certainly a rate-limit
deferral resolving quietly in the background, not a failure at all.

## 7. Summary checklist

**Adding and testing your own key:**
- [ ] Saved a key at `/settings/ai` for the provider this deployment uses
      (a rejected key is a `400` and nothing is stored)
- [ ] Tested it (`POST /api/ai/keys/openai/test`) and read `success` and each
      check's `code`/`detail`, not just the HTTP status (Section 3)
- [ ] Confirmed `GET /api/ai-tasks/config` reports `keyConfigured: true`

**Administering deployment policy:**
- [ ] AI switched on at `/admin/settings/ai`, key policy still `byok`
- [ ] At least one model enabled at `/admin/settings/ai/models`, with the
      capabilities the tasks need
- [ ] `defaultModel` and any task models name enabled models (a save that names
      one that is not is refused)
- [ ] `maxInputTokens` / `maxOutputTokens` sized for the templates this
      deployment actually uses, or left empty so each model's own maximum governs
- [ ] Provider slot and base URL tested from the page before relying on a
      non-default endpoint
- [ ] Understood there is no deployment-wide key to configure here — every
      user manages their own at `/settings/ai`

**Diagnosing a report of "AI doesn't work":**
- [ ] Checked `GET /api/ai-tasks/config` for the affected user: is it `available`
      that's false (a deployment problem) or `keyConfigured` (a
      that-user's-key problem)? (Section 5)
- [ ] If a specific note failed: read its failure reason and matched it
      against A–F in Section 6, rather than assuming "it's broken"
- [ ] If the note is stuck `generating` rather than `failed`: assumed a
      rate-limit deferral (E) resolving on its own before escalating

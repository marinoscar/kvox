# Runbook: AI Provider Keys and Note Generation

**Audience:** anyone who generates notes (adding and testing your own key —
Sections 1–3), and whoever administers this deployment's AI policy
(restricting models, diagnosing "AI is unavailable" reports — Sections 4–6).
**Applies to:** epic #45's note-generation feature — `/settings/ai` (per-user
keys), `/admin/settings/ai` (deployment policy), and the `note.generate`
pipeline behind `POST /api/notes`.

This runbook does not re-derive the design — the two state machines, prompt
assembly and the token budget, the streaming contract, and the full privacy
statement of what leaves this deployment and under whose account are
[`docs/specs/notes.md`](../specs/notes.md). It covers what an operator or a
user actually does: save a key, prove it works, restrict which models are
permitted, and tell apart the handful of ways "generate a note" can fail.

Source of truth for every claim below:

- `apps/api/src/ai/ai-credentials.controller.ts` /
  `apps/api/src/ai/user-ai-credentials.service.ts` — the per-user key
  surface (`/api/ai-credentials`), ownership-scoped, no permission string.
- `apps/api/src/ai/providers/openai.provider.ts` — `testConnection()`, the
  one place every `detail` sentence below comes from (HTTP status →
  message), and `generate()` for how a live request is classified.
- `apps/api/src/ai/ai-errors.ts` — the five-outcome taxonomy
  (`AiAuthError`, `AiInputError`, `AiRefusedError`, `AiBudgetError`,
  `RateLimitError`) and `isTerminalAiError`.
- `apps/api/src/ai/ai-settings.controller.ts` /
  `apps/api/src/ai/ai-settings.schema.ts` — the deployment policy
  (`/api/ai-settings`), the `ai` system-settings namespace, and the
  compile-time proof that no secret field can enter it.
- `apps/api/src/ai/ai-config.controller.ts` /
  `apps/api/src/ai/ai-config.service.ts` — `GET /api/ai/config`, the one
  capability probe every client (and this runbook) reads to answer
  "is AI usable, and does *this* user have a key."
- `apps/api/src/notes/handlers/note-generate.handler.ts` — the job that
  actually calls the provider: `profile: { maxAttempts: 1 }`, the
  per-user throttle key, and which failures return normally (terminal)
  versus rethrow (retryable/deferred).
- `apps/api/src/notes/generation/token-budget.ts` — `assertWithinBudget`,
  where a too-large prompt is refused with numbers, before any request is
  sent.
- `apps/web/src/pages/UserAiPage.tsx` and
  `apps/web/src/pages/Admin/AiSettingsPage.tsx` — the two UIs this runbook
  walks through.
- `docs/specs/notes.md` §2.2 (error taxonomy), §3.3 (token budget), §6.4
  (permission model), §9 (privacy) — the design behind all of the above.

**There is no deployment-wide AI key, and there never will be one under this
design.** Every provider key belongs to an individual user, is billed to
their own provider account, and a user with no key has no AI features — the
product says so rather than spending anyone else's account on their behalf.
Keep that in mind throughout: an administrator cannot "just add a key for
everyone," and every failure mode in Section 6 that traces back to a bad key
is that **specific user's** key, never the deployment's.

---

## 1. Before you start

- **A per-user key needs no permission** — `GET`/`PUT /api/ai-credentials`
  and `POST /api/ai-credentials/test` are gated only on being signed in.
  Any authenticated user, any role, can add and test their own key.
- **The deployment policy needs `system_settings:read`/`:write`** — the same
  pair that gates every other system-settings namespace (transcription,
  maintenance, database backup). There is no separate `ai:*` permission
  pair; `/admin/settings/ai` is reachable exactly where every other
  `system_settings:read`-gated admin card is.
- Decide which OpenAI-compatible endpoint this deployment will call before
  anyone saves a key against it — `AI_PROVIDER_IDS` (`ai-errors.ts`) lists
  `openai` as the only provider in this build today, and its `baseUrl` is a
  setting, not a constant, so an enterprise gateway or a self-hosted
  OpenAI-compatible server works exactly the same way a direct OpenAI
  endpoint does.

## 2. Adding and testing your own key

Visit `/settings/ai` (**AI Provider**, under user Settings — reachable by
every role, since `notes:read`/`notes:write` are seeded to all three).

1. **Paste the key and save.** `PUT /api/ai-credentials` with
   `{ "provider": "openai", "apiKey": "sk-…" }`. Saving a second time for
   the same provider **overwrites** the stored key; there is never a second
   row per `(userId, provider)`.
2. **Test it.** The page's **Test** action calls
   `POST /api/ai-credentials/test`, which probes the provider directly
   with the key you supply (or, if you leave the field blank, the key you
   already have stored) — the same request `note.generate` will make. See
   Section 3 for what each outcome means.
3. **Leaving the box blank never erases anything.** The form always renders
   the key field empty (the stored value is unreadable by design, even to
   you), so a blank submission on `PUT` is read as "keep what's stored" —
   useful for changing only the label. The **only** way to remove a key is
   `DELETE /api/ai-credentials/{provider}`, a dedicated, idempotent action.
4. **Nothing about the key is ever shown back to you or anyone else.**
   `GET /api/ai-credentials` returns a masked `hint` (`••••a1b2`) and a
   `label`, never the key — not to you, not to an administrator, not
   through any endpoint this application exposes.

## 3. What each `test` failure means

`POST /api/ai-credentials/test` **always answers HTTP 200**, whether the
probe succeeded or not — a refused probe is a successful diagnosis, and it
is the entire reason this endpoint exists. Read `ok`; when it is `false`,
`detail` names one of these, verbatim from `openai.provider.ts`:

| Provider response | `detail` says | What it actually means | What to do |
|---|---|---|---|
| `200` | "The provider accepted this key in *N* ms." | The key is valid and reachable. | Nothing — you're set up. |
| `401` | "The provider rejected this API key…" | **The key is wrong or revoked.** | Regenerate the key on the provider's own dashboard and paste the new one. |
| `403` | "The provider recognised this key but refused the request…" | The key is valid but scoped wrong — a different project, or missing permission for this endpoint. | Check which project/organization the key belongs to on the provider side. |
| `429` | "The key is valid but the account is currently rate-limited or out of credit…" | **Nothing is wrong with the key.** This is a usage/billing state on your own provider account. | Check your usage and billing pages with the provider. Retrying the probe immediately will usually repeat the same answer. |
| `404` | "The endpoint returned HTTP 404 for a documented route… the configured API base URL is probably wrong — an administrator sets that, not you." | The deployment's `baseUrl` is misconfigured. | This is not your problem to fix — tell an administrator (Section 4). |
| any other status | "The provider returned HTTP *nnn*: *snippet*" | An unexpected response from the provider. | Read the snippet; if it doesn't make sense, it's likely a transient provider-side issue — try again shortly. |
| a thrown error (no HTTP response at all) | "Could not reach *baseUrl* — …the request never got an HTTP response, so this is a network or configuration problem rather than a credential one." | DNS failure, TLS failure, connection refused, or the 10-second probe timeout. | A network/configuration problem, not a key problem — check the deployment's outbound network access, or escalate to an administrator if the base URL was recently changed. |

A **400** from this endpoint (not `ok: false` — an actual 400 status) is a
different thing entirely: an unknown provider id, or no key supplied and
none already stored. That's a malformed request, not a failed probe.

## 4. Restricting which models this deployment permits

Visit `/admin/settings/ai` (**AI**, in the admin **General** settings group,
`system_settings:read`/`:write`).

- **`enabled`** is the master switch. While `false`, no completion is
  requested from any provider, for anyone, regardless of who has a key
  saved.
- **`allowedModels`** is an allow-list a user's own key can reach but this
  deployment may still refuse — the one lever an administrator has over
  cost and over which vendor models this deployment's content may reach,
  since the key and the bill are each user's own. `PUT /api/ai-settings`
  **replaces this list wholesale**; there is no way to merge in one more
  model, so re-send the full list including the ones you're keeping. An
  **empty** list is a legal, deliberate state — "nothing is permitted" —
  and closes the feature by policy without touching `enabled`.
- **`maxInputTokens`/`maxOutputTokens`** bound the assembled prompt and the
  completion, under the model's own context window — see Section 6 for
  what a user sees when a note doesn't fit.
- **`maxDocumentBytes`** bounds one uploaded source document (25 MB by
  default). It lives in this AI policy, not a storage setting: the reason
  to bound it is that every byte becomes input tokens on the *uploading
  user's own* vendor account, not disk space.
- **Test the base URL before saving it.** `POST /api/ai-settings/test`
  accepts an optional `baseUrl` to probe a value you haven't saved yet.
  ⚠ This is a **reachability** probe only — it sends no credential, because
  this deployment holds none — and a `401`/`403` from the endpoint counts
  as `ok: true`: an unauthenticated request to a working API root is
  *supposed* to be refused, and that refusal is the proof it exists and
  speaks the protocol. It also always answers HTTP 200; read `ok` and
  `detail`.
- **A model id the policy permits that no registered provider declares**
  shows up in the response's `unknownModels` array — this is where a
  mistyped model id becomes visible, because an unrecognised model can't
  be budgeted and is silently never offered to any user.

There is no field anywhere on this page for a credential. If you're looking
for a way to give the whole deployment one shared key: there isn't one, by
design — see the note at the top of this runbook and `docs/specs/notes.md`
§9.

## 5. What "AI is unavailable" looks like, from each side

Every client — the note-creation flow, the template picker, this runbook —
reads exactly one endpoint to decide what to show: `GET /api/ai/config`
(gated on `notes:read`, seeded to all three roles, so every ordinary account
can read it). Two independent booleans answer two independent questions:

| | `available` | `keyConfigured` |
|---|---|---|
| **What it describes** | The deployment: is AI enabled, is the provider registered in this build, is at least one permitted model budgetable, do the token ceilings leave room for input. | **The calling user**, specifically: do *they* have a saved key for the active provider. |
| **Who can make it true** | An administrator, via `/admin/settings/ai`. | Each individual user, via `/settings/ai`. |
| **If it's false** | Nothing works for *anyone*, no matter whose key is saved. | This *one user* sees the "set up your AI key" prompt instead of the feature — everyone else may be fine. |

They are deliberately independent — a user can save and verify a key before
an administrator finishes turning the feature on, and an administrator can
finish configuring policy while a given user still has no key of their own.
**"AI is unavailable" is therefore never one diagnosis** — ask which of the
two is false:

- **From a user's perspective:** open `/settings/ai`. If there's no key
  saved (or `Test` fails per Section 3), that's `keyConfigured: false` —
  yours to fix.
- **From an administrator's perspective:** open `/admin/settings/ai`. If
  `enabled` is off, or `allowedModels` is empty, or every permitted model
  fails the token-ceiling math against `maxInputTokens`/`maxOutputTokens`,
  that's `available: false` — every user is blocked regardless of their own
  key, and only an administrator can fix it.

An administrator **cannot see whether any individual user's `keyConfigured`
is true** through this application — there is no admin listing of who has a
key saved. If a specific user reports "AI is unavailable" and
`/admin/settings/ai` looks correctly configured, the next question is
whether *that user* has saved and tested their own key (Section 2), not
whether the deployment is broken.

## 6. Diagnosing a failed generation

`note.generate` is `maxAttempts: 1` **by design** (see `CLAUDE.md`'s
"Notes, Note Templates and the AI Layer" section) — nothing about this job
type auto-retries, ever, because a second attempt would call the provider
with the user's own key a second time and, completions being
non-deterministic, show them different text than the partial stream they
already watched fail. `POST /api/notes/{id}/regenerate` is the only retry
path, and it's a person pressing a button. So every failure below is
**terminal** from the queue's point of view — the note goes to `failed`,
and the fix is for a human to act, not for the job to try again on its own.

Tell the three broad causes apart like this:

**A. A bad key (`errorClass: "auth"`).** The provider returned 401/403 to
the actual generation request — the identical failure Section 3's `test`
endpoint would have caught beforehand. Fix: the affected user re-saves or
regenerates their key at `/settings/ai`, tests it, then regenerates the
note.

**B. A token-ceiling refusal (`errorClass` is not set at all — this is a
400 at request time, before a job is even queued).** `assertWithinBudget`
(`generation/token-budget.ts`) runs *before* `POST /api/notes` or
`POST /api/notes/{id}/regenerate` creates anything, so this never shows up
as a failed note in the note list — it's a 400 response naming the actual
numbers: "this source is approximately *N* tokens; this model allows *M*
for input with this template and output length." **Nothing is silently
truncated** — see `AiBudgetError`'s header in `ai-errors.ts`; this is
deliberate, because a truncating "fix" would generate a note from *part* of
the source with nothing telling the user a paragraph vanished. Fix: shorten
the source, use a shorter template, pick a model with a larger context
window (if the policy permits one), or ask an administrator to raise
`maxInputTokens`/`maxOutputTokens` if the deployment ceiling — not the
model's own window — is the binding constraint.

**C. A provider outage or transient failure (unclassified — thrown as a
plain `Error`, not one of the four domain classes).** A 5xx, a dropped
socket, a DNS failure, a response that doesn't match what the provider
documents. `Job.lastError` records what actually happened; the note goes
to `failed` and the error is rethrown so the failure is visible rather than
silently reported as success. Fix: check the provider's own status page,
then use **Regenerate** — since this class is genuinely transient, a second
attempt (a human-initiated one, per the `maxAttempts: 1` policy above) is
likely to succeed once the provider recovers.

**D. A rate limit (`RateLimitError`, HTTP 429) is invisible, and that's
correct.** It never marks the note `failed` at all — the job is deferred
and retried automatically with backoff, on the **per-user** throttle key
(`aiProviderThrottleKey(userId)`), so one busy user's 429 never affects
anyone else's generation. If a note seems stuck `generating` for longer
than a few minutes, this is the most likely explanation; it will resolve on
its own once the provider's rate limit window passes. (Compare this to
Section 3's `test` probe reporting a 429 as "valid but out of credit" —
that's the same underlying provider state, diagnosed proactively instead of
discovered mid-generation.)

**E. The provider declined to answer (`errorClass: "refusal"`).** A
content-policy refusal or `finish_reason: 'content_filter'` — the request
was well-formed and the provider chose not to complete it. This is
deliberately a *different* message from B and C: "the provider declined to
answer this" is not the same news as "this application asked for something
invalid," even though both are terminal and neither auto-retries. Fix: a
different source, a different template, or accept that this particular
content will not generate.

**In short:** `auth` → the user's key. A 400 before a job exists → the
budget, with numbers. `refusal` → the provider's content decision, not a
bug. Anything else thrown → check the provider's status, then regenerate.
A note that never leaves `generating` → almost certainly a rate-limit
deferral resolving quietly in the background, not a failure at all.

## 7. Summary checklist

**Adding and testing your own key:**
- [ ] Saved a key at `/settings/ai` for the provider this deployment uses
- [ ] Tested it (`POST /api/ai-credentials/test`) and read `ok`/`detail`,
      not just the HTTP status (Section 3)
- [ ] Confirmed `GET /api/ai/config` reports `keyConfigured: true`

**Administering deployment policy:**
- [ ] `enabled: true` at `/admin/settings/ai`
- [ ] `allowedModels` includes at least one model this build recognises
      (check `unknownModels` for typos)
- [ ] `maxInputTokens`/`maxOutputTokens` sized for the templates this
      deployment actually uses
- [ ] Base URL tested via `POST /api/ai-settings/test` before saving, if
      pointing at anything other than the default OpenAI endpoint
- [ ] Understood there is no deployment-wide key to configure here — every
      user manages their own at `/settings/ai`

**Diagnosing a report of "AI doesn't work":**
- [ ] Checked `GET /api/ai/config` for the affected user: is it `available`
      that's false (a deployment problem) or `keyConfigured` (a
      that-user's-key problem)? (Section 5)
- [ ] If a specific note failed: read its failure reason and matched it
      against A–E in Section 6, rather than assuming "it's broken"
- [ ] If the note is stuck `generating` rather than `failed`: assumed a
      rate-limit deferral (D) resolving on its own before escalating

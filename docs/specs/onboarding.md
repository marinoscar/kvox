# Onboarding: This App's Steps on the Platform Slice

> Epic #271 built the first-run checklist (issues #272 to #281). Issue #481 (epic
> #478) moved it onto the platform onboarding slice: the routes, the engine, the
> stored namespace, the checklist, the Setup guide, Get started and the welcome
> dialog are `@marinoscar/platform-api/onboarding` and
> `@marinoscar/platform-web/onboarding/{headless,ui}`. This app keeps what is its
> own: five domain steps, the facts they read, one derived `admin.ai`, the shell
> banner and the welcome panes. The platform's design, guardrails and extension
> points are in the
> onboarding spec of the EnterpriseAppBase repository (`docs/specs/onboarding.md`);
> this document is what this app adds and the decisions that stayed.
>
> The wire shape is in the `### Onboarding` group of [`API.md`](../API.md#onboarding).
> The places where the platform behaves differently from what this app ran before are
> the "Onboarding differences (issue #481)" table of
> [`platform-adoption/local-exceptions.md`](../platform-adoption/local-exceptions.md).

## 1. What this solves

A brand-new deployment is a blank room with the lights off. Transcription is
off and has no provider, AI is off with no model enabled, so an administrator
who logs in lands on Home, reads "You have no transcripts yet", and finds a
disabled New-transcript button. An ordinary user has a different gap: AI keys
are per user with no deployment-wide fallback by design
([notes.md](notes.md) §9), and the first they learn of it must not be
`AiKeyRequired` partway through a task they had already decided to do.

Both personas get a persistent, resumable, **live-derived** checklist that names
what is missing and links to the page that fixes it, plus one short, skippable,
replayable introduction that sets expectations (the bring-your-own-key surprise
included) before either trips over them.

## 2. Decisions that did not change

**Derived, never stored.** A stored "done" boolean lies the moment a deployment
changes: rotate the transcription key out of `credentials` and the tick would
stay green over a deployment that cannot transcribe. Every status is computed on
every `GET /api/onboarding`; nothing writes a completion row. The only stored
state is the user's **intent** (welcome seen, checklist dismissed, steps
skipped), which can only change because the user changed it and must survive a
new browser, which is why it is a settings namespace and not `localStorage`.

**A step never issues a query.** The engine resolves each *fact* at most once per
request, in parallel, before any step runs; a step's `evaluate` is a pure
function of the facts it names. The cost of the route is a function of the facts
registered, not of the number of steps. A fact that rejects omits the steps that
need it (one logged warning) and never fails the response.

**Three statuses, not a boolean.** `done`, `todo`, and `blocked` with a
`blockedReason`. `blocked` is what keeps "your administrator has not connected a
transcription provider" distinct from "you have not recorded anything yet": two
different sentences, two different fixes, two different people to talk to. A
skippable step especially must distinguish "you cannot do this yet" from "you
have declined this" (`admin.smoke_test`).

**A checklist, not a tour.** Three panes of context make one claim each and get
out of the way; a coach-mark tour arrives before the user has any need for what
it says and is skipped and forgotten. The second pane (AI runs on your own
provider key) is why the introduction exists.

**Absent means "never onboarded".** The namespace has no default; an emptied
namespace collapses back to absent, never `{}`.

## 3. How it is wired

| Piece | Where |
|---|---|
| The slice | `apps/api/src/platform/onboarding/onboarding.config.ts`: `OnboardingModule.forRoot({ imports: [OnboardingHostModule] })`, mounted in `app.module.ts`. `adminPermission` is the default `system_settings:read` |
| The data port | `onboarding-data.adapter.ts` (bound to `ONBOARDING_DATA` by `onboarding-host.module.ts`): a `select` of the caller's `user_settings.value`, the allowlist count, the push-subscription check and the metrics' one aggregate statement inside a `READ ONLY` transaction. `transcripts`, `notes` and `users` carry no row-level-security policy, so no bypass client is involved. `ONBOARDING_FEATURES` is not bound: no step names a `feature` |
| Base facts and steps | `onboarding.facts.ts`, `onboarding.steps.ts`, registered with the platform's own by `onboarding.manifest.ts` |
| Domain facts and steps | beside their domain (base code may not import domain code, `test/architecture/base-domain-boundary.spec.ts`): `kvox/transcription/transcription.onboarding.ts`, `transcripts/transcripts.onboarding.ts`, `notes/notes.onboarding.ts`, registered by `kvox.manifest.ts` |
| The stored namespace | the platform's `ONBOARDING_USER_SETTINGS`, listed in `app-registrations/settings.ts` so the stored key order stays `dataTables`, `navigation`, `notifications`, `onboarding`, `graph` |

`kvox.manifest.ts` is the composition root every entry point loads first, and it
imports `onboarding.manifest.ts`: the namespace's merge refuses a `skipped` id
that is not a registered, skippable step, so the registry must be filled in any
process that can handle `PATCH /api/user-settings` (the OpenAPI dump and the
specs included).

## 4. The steps

Ids are permanent (they are stored in `onboarding.skipped`). Titles, hrefs,
permissions and skippable flags of the five domain steps moved verbatim.

| Id | Audience | Tier | Skippable | Permission | Source | Done when |
|---|---|---|---|---|---|---|
| `admin.storage` | admin | required | no | `storage_config:read` | platform | the Doctor's `storage.config` and `storage.bucket` pass |
| `admin.transcription` (15) | admin | required | no | `system_settings:read` | app | `transcriptionAvailable` |
| `admin.email` | admin | required | no | `system_settings:read` | platform | the Doctor's `email.config` passes |
| `admin.access` | admin | required | no | `allowlist:read` | platform | the allowlist holds an address other than `INITIAL_ADMIN_EMAIL` |
| `admin.ai` | admin | recommended | yes | `ai_config:read` | platform step, app condition (§5) | the Doctor passes **and** a model is enabled |
| `admin.smoke_test` (45) | admin | recommended | yes | `transcripts:write` | app | the caller owns a `ready` transcript; **blocked** until transcription is connected |
| `admin.push` | admin | recommended | yes | `push:read` | platform | the Doctor's `push.vapid` passes |
| `admin.backup` | admin | recommended | yes | `db_backup:read` | platform | the Doctor's `backup.schedule` passes |
| `admin.org-invite` | admin | recommended | yes | `org_invites:write` | platform | never applies (single organization) |
| `user.ai_key` (1) | user | required | no | none | app | the caller has a key; **absent** while no provider slot is on |
| `user.first_transcript` (2) | user | required | no | `transcripts:write` | app | the caller owns a live transcript; **blocked** while transcription is not connected |
| `user.first_note` (3) | user | recommended | yes | `notes:write` | app | the caller owns a live note; **blocked** without AI, or without a key |
| `user.profile` | user | optional | yes | none | platform | a display name or an uploaded picture |
| `user.notifications` | user | optional | yes | none | platform | notification preferences saved, or a push subscription |

The email-before-access order (20 before 30) is the platform's and still the
right one: adding an address to the allowlist fires `allowlist.invitation`,
which is email-only, so inviting somebody before outbound email works sends
nothing at all and shows no failure anywhere.

`user.ai_key` is keyed on the provider slot, not on the deployment being fully
set up: a deployment whose OpenAI slot is off has no vendor a key could belong
to, so the step is absent rather than pending against nothing. It is never
blocked: a user may save a key before the administrator has finished.
`user.first_note` checks the deployment's readiness **first**, so "add your key
first" never points at a step the user cannot see.

## 5. Why there is one `admin.ai`, and why it is not the built-in as shipped

The platform's built-in `admin.ai` is done when the Doctor's `ai.enabled` and
`ai.providers` pass. Under this application's `byok` policy those checks need no
deployment key (the policy never promises an organization-key fallback), so the
built-in agrees with this app's posture. It does **not** ask whether a model is
enabled in the `ai_models` catalogue, and this app's step always did: a
deployment with OpenAI switched on and an empty catalogue cannot generate a
note, and the built-in would call it done.

So `ADMIN_AI_STEP` copies the built-in (title, text, href, permission, tier,
skippable, Doctor checks, order) and adds the `aiReadiness` fact's `available` (AI on,
provider slot on, at least one model enabled) to its done condition. The manifest
registers it and leaves the built-in out; the registry spec pins that there is
exactly one `admin.ai` and that every platform built-in kept its id. The
derivation is a declared shim in
[`local-exceptions.md`](../platform-adoption/local-exceptions.md). The platform's
tier for this step is `recommended`, where this app's was `required`; the
platform's tier is adopted.

## 6. Facts

Each fact is registered as `<prefix>.<name>` (the prefix is the app slug, spelled once in `onboarding.facts.ts`) and resolves with one bounded read:

| Fact | Reads |
|---|---|
| `transcriptionAvailable` | `TranscriptionConfigService.getConfig().available`, the four-fact conjunction that service documents. Never re-derived: a second implementation is how a checklist ends up green over a disabled upload button |
| `ownTranscriptCount` | `transcript.count` for the caller, `deletedAt: null` |
| `ownReadyTranscriptCount` | the same, `status: 'ready'` |
| `ownNoteCount` | `note.count` for the caller, `deletedAt: null` |
| `aiReadiness` | `KvoxAi.readiness(caller, 'note_generate')` reduced to `{ available, hasKey, providerSet }`. `available` is "usable, or usable once the caller adds a key" |

Soft-deleted rows are excluded everywhere: a count that included them would tell
a user who deleted their only recording that they are still activated.

The activation funnel (`GET /api/admin/onboarding/metrics`) counts
`user.first_transcript` and `user.first_note` through each step's `funnelSql`
(a cohort user who owns a live row), beside the platform's profile and
notifications steps.

## 7. Where the state lives

`user_settings.value.onboarding.{welcomeSeenAt, checklistDismissedAt,
adminDismissedAt, skipped}`, written through `PATCH /api/user-settings` with
`If-Match` (the platform client reads the version first and retries once on a
409). Two dismissals, not one: an administrator is also a user, and putting the
personal checklist away must not hide the deployment's.

`skipped` accepts only registered, skippable step ids, at most 32. A required
step cannot be skipped (refused at registration). A skipped step is still
returned, marked, so the page can offer to undo it.

**The migration.** `20261016120000_onboarding_checklist_dismissed_at` renames
`dismissedAt` to `checklistDismissedAt` in every stored row, because the
platform namespace is strict and would refuse the whole namespace on the old key.
It is idempotent (a row that already carries the new key keeps it and loses only
the stale one), leaves rows with no onboarding or a non-object one alone, and
touches nothing else. `skipped` needs no rewrite: the ids are unchanged, and ids
the platform no longer registers as skippable (`admin.email`, `admin.access`,
now required) are dropped on read and by the next write. The reverse statement,
for a rollback to the previous build, is in the migration's header. The row is
`user_settings`, not an organization table, so no bypass is needed.
`test/onboarding/onboarding-migration.db.spec.ts` runs the migration's own SQL
against fixture rows.

## 8. The surfaces

- **The provider** is the platform's `OnboardingProvider`, mounted once in
  `components/common/Layout.tsx` inside `ProtectedRoute`. It reads once and never
  polls. A failed read renders nothing, never an error banner raised from the
  shell. The two route components refresh it when they mount, because a user
  returning from "New transcript" must see that step done.
- **The banner** (`components/onboarding/OnboardingBanner.tsx`) is this app's: the
  platform ships no banner. It reads the platform hook, speaks about the
  deployment while an administrator has a required step open and otherwise about
  the account, counts `blocked` as open, dismisses with the matching platform
  action, and says nothing on the page it links to.
- **The welcome dialog** is the platform's, with `components/onboarding/kvoxWelcomePanes.tsx`
  in `slots.userPane` and `slots.adminPane`: the same three panes as before (what
  it does; AI runs on your own key, all three BYOK facts; the checklist), with a
  Back/Next stepper in the body. Every way out marks the welcome seen, and it
  never reopens on its own, including after a release adds a step.
- **Setup guide** (`/admin/settings/setup`, `system_settings:read`) and **Get
  started** (`/settings/getting-started`, no card permission) are the platform's
  pages behind `components/onboarding/{SetupGuideRoute,GettingStartedRoute}.tsx`.
  This app's content rides in their `BeforeContent` slot: the BYOK explanation on both
  (on Get started, the three facts and the link to the key page), and the inline
  "Invite by email" on the Setup guide for a holder of `allowlist:write`. Their
  registry cards are the package's (`setupGuideSettingsPage.card`,
  `gettingStartedSettingsPage.card`), first in `General` and `Account`.

- **Home** is packaged (issue #632): the first-run journey ("Start here", the four
  stage cards and the call to action) and the rest of the page are `KvoxHomePage` of
  `@marinoscar/kvox-web/home/ui`, so the web edition and the desktop host show the same empty
  state. It is a different thing from the checklist above: the journey explains the
  product to an account with nothing yet and ends in the steps a host offers
  (`extraSteps`: web's "Record or upload audio", Desktop's "Import a document"), while
  the checklist is live-derived deployment and account state. This app's binding is
  `pages/HomePage.tsx`; the slots and the rules are in the
  [home README](../../packages/kvox-web/src/home/README.md).

`GET /api/onboarding` needs `user_settings:read`, which every seeded role holds,
so a Viewer (the default role) reads their checklist. The integration suite
asserts both halves: a caller holding no permission is refused with 403, and a
Viewer gets 200 with no admin block and only the steps they can act on.

## 9. Verification

| What | Where |
|---|---|
| Registry: one `admin.ai`, ids, tiers, skippable flags, order, every fact registered | `apps/api/test/onboarding/onboarding-steps.spec.ts` |
| Statuses and blocked reasons through the real engine; a Viewer never resolves an admin fact; each fact resolved once | the same |
| The route over the real guard stack | `apps/api/test/onboarding/onboarding.integration.spec.ts` |
| The stored-intent migration | `apps/api/test/onboarding/onboarding-migration.db.spec.ts` (needs Postgres, `npm run test:db`) |
| The platform's `onboarding` conformance suite (registries well formed, permissions exist, one derivation resolves each fact once and reads nothing while evaluating) | `apps/api/test/conformance.spec.ts` |
| The namespace's wire behaviour | `apps/api/test/settings/user-settings.integration.spec.ts`, `stored-shape.db.spec.ts` |
| Banner, welcome panes, the two routes and their cards | `apps/web/src/__tests__/components/onboarding/` |

## Rejected alternatives

- **A stored completion flag per step.** Wrong in the direction that matters (a
  green tick over a broken deployment) and every configuration change becomes a
  stale record nobody can repair.
- **A step that runs its own query behind a memo.** Memoisation makes the cost
  *usually* bounded, which is a different property from bounded.
- **Registering a second `admin.ai` beside the built-in.** Two visible AI steps. The
  built-in is derived instead (§5).
- **A guided tour with coach marks.** It arrives before the need and is skipped.
- **Keeping the return-to-setup bar.** The platform's checklist links carry no
  `?setup=<id>` marker, so the bar could never appear; writing the marker would
  mean a second, app-only checklist.
- **A fourth welcome pane.** Setup flows lose a third or more of their users
  past five steps, and this is a preamble to setup, not setup.

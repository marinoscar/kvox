# Onboarding: The First-Run Checklist

> Epic #271 (issues #272, #274, #275, #276, #277, #278, #279, #280; this
> document is #281). Implemented in `apps/api/src/onboarding/`
> (`onboarding-steps.ts`, `onboarding.service.ts`, `onboarding.controller.ts`,
> `admin-onboarding.controller.ts`, `dto/onboarding-state.dto.ts`,
> `onboarding.module.ts`), the `onboarding` namespace of
> `apps/api/src/common/schemas/user-settings-namespaces.schema.ts` and its
> parity guard (`apps/api/src/common/schemas/user-settings-parity.spec.ts`),
> and on the web side `apps/web/src/services/onboarding.ts`,
> `apps/web/src/contexts/OnboardingContext.tsx`,
> `apps/web/src/components/onboarding/{SetupChecklist,OnboardingBanner,
> WelcomeDialog,ReturnToSetupBar,onboardingPaths}.tsx|ts`,
> `apps/web/src/pages/Admin/SetupPage.tsx`,
> `apps/web/src/pages/GettingStartedPage.tsx`, and the `Setup`/`Getting
> Started` cards in `apps/web/src/config/adminSections.tsx` and
> `apps/web/src/config/userSettingsSections.tsx`. This document lands after
> every other child issue, following the same convention
> `docs/specs/notes.md` (issue #60 of epic #45), `docs/specs/ux-refresh.md`
> (#113 of #105) and `docs/specs/search.md` (#177 of #164) each set: a spec
> written last describes what was actually built, including the decisions
> that only surfaced during implementation. It is **not** a usage guide for
> the checklist itself, and it does not restate `CLAUDE.md`'s MANDATORY
> "Onboarding" rule block — that states two invariants; this explains why
> they exist and gathers the decisions the epic's nine issues each argued
> for.

## 1. What this solves

A brand-new instance is, on first login, a blank room with the lights off.
The seed values that make it one are concrete, not rhetorical: `DEFAULT_SYSTEM_SETTINGS`
(`apps/api/src/common/types/settings.types.ts`) ships `transcription.enabled:
false`, `transcription.provider: null`, and `ai.allowedModels: []`. An
administrator who logs in for the first time lands on Home, reads "You have
no transcripts yet", and finds a **disabled** New-transcript button —
because nothing has named a speech-to-text vendor, let alone stored a key
for one. Note generation is dead for the identical reason: `allowedModels`
starts empty, so there is no model any user is permitted to use even once
someone configures a vendor. Before this epic, the only hint anywhere in the
application was a single sentence inside `NewTranscriptButton.tsx` — visible
only after pressing a button that does not work — and there were **13 admin
settings cards** across three groups with nothing saying which two of them
the product cannot run without.

The ordinary user's gap is different in kind, not degree. `user_ai_credentials`
has no deployment-wide fallback **by design** (`docs/specs/notes.md` §9):
every note generation is billed to the user's own vendor account, and the
key that authorises it must come from the user, not the deployment. Nothing
in the product said so before this epic — the first a user learned it was
hitting `AiKeyRequired.tsx` **partway through** a task they had already
decided to do, which the research this epic's design leans on records as the
exact moment a task gets abandoned rather than merely delayed.

`apps/web/src/components/home/JourneyEmptyState.tsx` came closest to
addressing either gap and does neither: it explains the product's *thesis*
— Capture → Correct → Transform → Find — but names no action and knows
nothing about what is or is not configured for the account looking at it.

This epic gives both personas a persistent, resumable, **live-derived**
setup checklist that names exactly what is missing and links straight to
the page that fixes it, plus one short, skippable, replayable introduction
that sets expectations — the BYOK surprise included — before either persona
trips over them.

## 2. Two personas, two activation milestones — why a checklist, not a tour

The two checklists answer different questions for different reasons, and
the registry keeps them as two arrays of one shared interface rather than
two modules for exactly that reason (§4): the **admin** checklist
(`ADMIN_ONBOARDING_STEPS`, seven entries — three `required`, four
`recommended`) is about whether the *deployment* can do its job; the **user**
checklist (`USER_ONBOARDING_STEPS`, four entries — two `required`, one
`recommended`, one `optional`) is about whether *this account* has done
anything with it yet.

Four findings shaped a checklist rather than a tour, each ruling out a
specific alternative:

1. Activation-driven flows beat feature tours by 30–50% on 90-day
   retention — onboarding is an activation system, not a guided walkthrough.
2. Coach marks and step-by-step tours are skipped and forgotten: they arrive
   before the user has any need for the content they carry.
3. An empty state is the one UI surface every new user encounters, and it
   persists until acted on; a tour fires once and disappears, taking its
   information with it.
4. Setup wizards should stay under five steps — front-loading friction is
   the most common onboarding failure — and an administrator needs *setup*
   while an ordinary user needs *workflow adoption*, which is why this is
   two checklists and not one merged flow (§6 returns to the merge question
   from the routing side).

So the shape is a checklist (four user steps; seven admin steps, tiered
required/recommended) plus exactly one three-pane welcome dialog (§8.3) that
is skippable, Escape-dismissible and replayable — never a step-by-step tour
overlaid on real UI. No tour dependency was added: MUI's own `Stepper` and
`Dialog` are sufficient for the one preamble this epic needs, and
`WelcomeDialog.tsx`'s own header states the same research as the reason a
fourth pane was rejected, not only a tour library.

## 3. Derived, never stored

Two failure modes were designed out before a line of the registry was
written, and `onboarding-steps.ts`'s own header states them as the two
things this design exists to rule out:

1. **Stored completion booleans lie.** An administrator who rotates the
   transcription key out of `credentials` — revoking it at the vendor,
   rolling it, anything that leaves the stored value pointing at a
   credential that no longer authenticates — would keep a green tick over a
   deployment that can no longer transcribe, if completion were a flag set
   once and never re-checked. So `admin.transcription`'s status is `ctx.transcription.available
   ? 'satisfied' : 'pending'`, evaluated fresh on every `GET
   /api/admin/onboarding`, with no cache and no repair path to remember
   because there is nothing to repair.
2. **A per-step query makes the endpoint's cost a function of the
   registry's length.** Eleven steps issuing their own reads is eleven round
   trips that grow every time somebody adds a twelfth, invisibly at the call
   site — see §4 for how the context builders rule this out structurally
   rather than by convention.

The only onboarding state persisted anywhere in this epic is the caller's
own **intent**: `welcomeSeenAt`, `dismissedAt`, `adminDismissedAt`,
`skipped[]` — the `onboarding` user-settings namespace (§7). Readiness and
intent are deliberately different kinds of fact and are kept on different
objects for that reason: `OnboardingService`'s header states that a step's
`evaluate` is never handed the skip list, because a step that could see
whether it was skipped would eventually be written to report itself
`satisfied` when skipped — the stored-completion lie arriving through a
different door. The skip list is applied once, outside every step, in
`OnboardingService.render`.

## 4. The step registry and its one-pass context

`apps/api/src/onboarding/onboarding-steps.ts` is a registry in the shape
this codebase already uses for `NOTIFICATION_EVENTS`, `JobHandlerRegistry`
and `ADMIN_SECTIONS`: one entry per step, and adding a step costs exactly
that entry — no controller branches on a step key, no service has a
`switch`, and `OnboardingService.render` states in its own comment that the
moment a `switch (step.key)` lands there, adding a step stops being free.

An `OnboardingStep<Ctx>` carries `key`, `audience`, `tier`, display copy, an
`href`, an optional `permission` (the exact string the destination's
controller enforces — Settings UI Pattern rule 3, applied on this axis), a
`skippable` flag, and two pure functions: `applies(ctx)` (is this step
relevant to this caller at all) and `evaluate(ctx)` (what is its status).
Both take `ctx` as their only argument and must not mutate it or read
anything else — `onboarding.service.spec.ts`'s "step purity" suite asserts
exactly that, per step.

**Two context types, not one with nullable admin facts.**
`OnboardingUserContext` and `OnboardingAdminContext` are separate
TypeScript interfaces, and the two step arrays are typed against them
separately. That is a compile-time guarantee, not merely a runtime
convention: a user step *cannot* read email settings, VAPID configuration,
the backup schedule or the account counts, because those fields are not on
the type it is handed. A single context shaped `{ admin: AdminFacts | null }`
would have made the identical promise only at runtime, enforced by an `if
(!ctx.admin) return` in every admin step that a later edit could forget to
write. They remain one file and one shared `OnboardingContext` union so the
two checklists cannot drift into different shapes, which is what would
happen if each audience got its own registry module.

`OnboardingService.buildUserContext(userId)` and
`buildAdminContext(userId)` are the one-pass builders §3 promised: each
issues a fixed set of reads inside a single `Promise.all` and returns one
frozen object every step then evaluates against. `onboarding.service.spec.ts`'s
"bounded read count" suite adds a step to each registry at test time and
re-counts the reads issued, asserting the count changes by **zero** — the
mechanism that makes "a step never issues its own query" a property of the
code rather than a convention someone could quietly violate. Every fact on
either context is read from a service that already implements the real
readiness check — `TranscriptionConfigService.getConfig()`,
`AiConfigService.getConfig(userId)`, `EmailSettingsService.describeForAdmin()`,
`PushConfigService.describeForAdmin()`, `SystemSettingsService`'s AI and
backup policies, and four `prisma.count()` calls — precisely so the
checklist never reimplements a conjunction some other file already argues
for and could drift from. Transcript and note counts filter `deletedAt:
null`, the same visibility predicate `transcripts.service.ts` and
`notes.service.ts` use for their own lists, so a user who deleted their only
recording is not reported as still activated.

`buildAdminContext` is reachable only from `AdminOnboardingController`
behind `system_settings:read` (§6); a Viewer's request to `GET
/api/onboarding` never executes it, so an admin-only fact is never computed
on that caller's behalf — a structural property of two separate functions,
not a filter applied to a shared one afterward.

## 5. Three statuses, not a `satisfied` boolean

Every step reports one of `satisfied` / `pending` / `blocked`, and `blocked`
is the whole reason a boolean was rejected: it is what keeps "your
administrator has not connected a transcription provider" distinct from
"you have not recorded anything yet." That is the identical distinction
`apps/api/src/ai/dto/ai-config.dto.ts` already draws by keeping `available`
(may this deployment offer AI at all) and `keyConfigured` (has *this*
caller saved a key) independent fields rather than one collapsed answer —
two different sentences, with two different fixes, and two different
people to talk to. Collapsing the onboarding statuses into one boolean would
leave the UI to invent its own "why not" logic out of whatever fields
remained, which is exactly the conflation `ai-config.dto.ts`'s own header
refuses.

Concretely, `blocked` appears in three places, each naming who has to act:

- `admin.smoke_test` is `blocked` (not `pending`) while
  `admin.transcription` is unsatisfied — a required step you cannot yet
  perform must say why rather than sit there looking like an ignored to-do.
- `user.first_transcript` is `blocked`, naming the administrator, when
  `transcription.available` is false — a user staring at a disabled upload
  button is told this is not their mistake and no amount of retrying fixes
  it.
- `user.first_note` is `blocked` twice over: naming the administrator when
  `ai.available` is false, and naming the caller's own missing key when AI
  works but they have not added one yet — checked in that order
  deliberately, because when no vendor is configured `user.ai_key` is
  absent from the list entirely, so "add your key first" would point at a
  step the caller cannot see.

`user.ai_key` is the one step that must stay actionable and **never**
`blocked` while a vendor is named but AI is switched off deployment-wide.
It is keyed on `ai.provider !== null`, not on `ai.available` — issue #83's
distinction, populated even while AI is off, precisely so a user can save
and verify a key *before* an administrator finishes enabling the feature.
Blocking it here would reinstate a deadlock: the first administrator of a
fresh deployment has to call the vendor with their **own** key to populate
the model list `admin.ai` needs, so nobody could go first if the step
insisted the deployment be ready before it would accept a key.

## 6. Two routes, two gates

`GET /api/onboarding` (`@Auth()`, no permission string) answers the
caller's own checklist; `GET /api/admin/onboarding`
(`@Auth({ permissions: [SYSTEM_SETTINGS_READ] })`) answers the deployment's.
Two prefixes, the same split `/api/nodes` and `/api/admin/nodes` already
make, and for the identical reason: the admin surface sits outside the
non-admin one *by construction* — because `buildAdminContext` and
`buildUserContext` are two separate functions (§4) — rather than by a
runtime check inside one shared handler.

**Why the user route carries no permission string.** The resource is the
caller's own onboarding state, scoped by `userId` in the query itself — the
identical ownership-scoped posture `/api/ai-credentials`, `/api/pat` and
`/api/user-data` already take. It must be readable by a plain Viewer, this
application's default role and therefore the role most likely to be looking
at a getting-started page, and every candidate permission string is either
seeded Admin-only or belongs to a controller this route has nothing to do
with.

**Why the admin route reuses `system_settings:read` instead of inventing
`onboarding:read`.** Epic #118 decision 8 set the precedent when the About
card was gated on `system_settings:read` with deliberately no `about:read`:
"what is deployed here, and is it finished" is an administrator's
configuration read, not a new authority, because every fact
`GET /api/admin/onboarding` reports is one the holder of that permission can
already read directly through the transcription, AI, email, push and backup
settings endpoints. Inventing a string would not be free either — it would
mean a seed migration, an edit to `apps/web/visual/main.tsx`'s
`DEFAULT_PERMISSIONS`, and an edit to `mockAdminUser` in `test-utils.tsx` —
three edits in exchange for a gate that is a synonym for one that already
exists.

**This is deliberately not the rejected `GET /api/home/summary`.** This
repo already rejected one aggregate endpoint on the ground that it would
have to decide, per caller, which half of its own body to withhold —
`HomePage.tsx`'s own header rejects `GET /api/home/summary` because it would
be gated on two different permissions and would "have to answer PARTIALLY
for a user holding one of them: a 200 carrying half the body, with some new
per-section 'you may not see this' marker invented for a single page." A
single onboarding endpoint would be the same shape and worse: an empty
admin-steps array is indistinguishable from "nothing left to do," so a
Viewer would be shown what looks like a fully-configured deployment. The
two-route split is what guarantees an admin-only fact is never even
computed for a non-admin caller, rather than computed and then withheld.

⚠ **The permissionless-route trap.** `@Auth()` with no roles and no
permissions is what `GET /api/onboarding` deliberately declares, and it has
a consequence that is not obvious from the decorator: `RolesGuard` and
`PermissionsGuard` are what attach the resolved permission list to the
request as `request.requestUser`, and **both of them return early** —
attaching nothing — on a route that declares neither roles nor permissions,
because there is nothing for either guard to check. `@CurrentUser()`
therefore hands the controller the raw `AuthenticatedUser`, whose
`.permissions` field does not exist at all. Read as `user.permissions`, that
is `undefined`; treated as a permission set, `undefined` is an **empty**
one — which silently filters every permissioned step (three of the user
checklist's four) out of a 200 response, leaving a caller with a checklist
missing three-quarters of its rows and no error anywhere saying why. It was
caught during this epic's build precisely this way. The fix lives in
`onboarding.service.ts`'s `normalizeCaller`, which checks whether the object
`@CurrentUser()` handed back already carries a `permissions` array and, if
not, runs it through `toRequestUser` (`auth/interfaces/authenticated-user.interface.ts`)
to derive one from the user's roles. This is a trap for **any** future
permissionless route that needs the caller's permission list, not only this
one — the fix pattern is `normalizeCaller`/`toRequestUser`, not a
per-route workaround.

**Why the unit spec was blind to it.** `onboarding.service.spec.ts`
constructs a `RequestUser` directly and passes it straight into
`OnboardingService`'s methods, so the shape is correct *by construction* —
the very question the trap is about (what does `@CurrentUser()` actually
hand back on this route) never arises in a suite that builds its own input.
Only a request driven through the real guard stack exposes the gap between
what a route decorator promises and what `@CurrentUser()` delivers, which is
the argument for `apps/api/test/onboarding/onboarding.integration.spec.ts`
existing at all rather than treating the unit suite as sufficient: its "a
user with an empty permission set gets 200" and "offers every step whose
permission the caller DOES hold" cases are the ones that would have caught
this regression, and did.

## 7. Where the state lives

The `onboarding` namespace (`apps/api/src/common/schemas/user-settings-namespaces.schema.ts`)
holds exactly the four intent fields from §3, `.strict()` so a misspelt
field is a 400 rather than silently dropped, with **no `.default()`
anywhere** — an absent namespace has to mean "this user has never been
onboarded," which is information a default would destroy. `skipped` is
bounded (`ONBOARDING_MAX_SKIPPED = 40`, `ONBOARDING_MAX_STEP_KEY_LENGTH = 64`,
`ONBOARDING_STEP_KEY_PATTERN = /^[a-z][a-z0-9_.]*$/`) as a genuine security
control, not cosmetics: it is a user-supplied array landing in a JSONB blob,
and the bound is what stops it becoming arbitrary storage.

Adding a user-settings namespace is a **six-file change**
(`userSettingsSchema`, `userSettingsPatchSchema` in
`common/schemas/settings.schema.ts`; `updateUserSettingsSchema`,
`patchUserSettingsSchema` in `settings/dto/update-user-settings.dto.ts`;
`userSettingsResponseSchema` in `settings/dto/user-settings-response.dto.ts`;
and the `UserSettingsValue` TypeScript interface in
`common/types/settings.types.ts`), and `dataTables` and `navigation` were
both added blind, with no guard. The nastiest of the six to miss is the
PATCH request schema: a missing entry there means `PATCH { "onboarding": {
"welcomeSeenAt": "..." } }` parses to `{}`, the service merges nothing, the
row is rewritten unchanged, and the endpoint answers **200 with a body that
looks correct** — no error, no log line, no audit entry, just a welcome
dialog that will not stay dismissed and nothing anywhere saying why. This
epic pays that six-file cost for the first time with a guard behind it:
`user-settings-parity.spec.ts`, modelled on `settings-parity.spec.ts` but
not copied from it, because user settings has a genuinely different amount
of help from the compiler — every namespace here is optional in all six
sources by design, so there is no required-field mismatch for TypeScript to
catch on its own the way the system-settings guard's own header describes.
Key sets are derived **programmatically** from the zod schemas (an
`unwrap()` helper strips `.optional()`/`.nullable()`/`.default()`/`.pipe()`
wrappers before comparing), never from a list written out by hand in the
spec — a hand-maintained list would be the same class of defect one level
up. The seventh place, the hand-written `mergeOnboarding` in
`user-settings.service.ts`, is deliberately **not** checked by this guard: a
merge is behaviour, not a key set, and is instead covered by
`user-settings.service.spec.ts` and by
`apps/api/test/settings/user-settings.integration.spec.ts`, which drives a
real PATCH through the wire DTO.

`onboarding` is present on the `UserSettingsValue` **interface** but
absent from `DEFAULT_USER_SETTINGS`, matching `dataTables`/`navigation`/`notifications`
exactly — seeding a default here would destroy the "absent means never
onboarded" contract the rest of the epic reads.

**Writes go through the existing `PATCH /api/user-settings`, not a new
endpoint.** `dismiss`, `skip`, `unskip` and `markWelcomeSeen`
(`OnboardingContext.tsx`) are each one PATCH into the `onboarding`
namespace, through the existing `useUserSettings` hook, which already
carries `If-Match` optimistic concurrency. There is no dedicated onboarding
write route to add or to re-earn that machinery for.

⚠ **The 409 retry finding.** #276's own acceptance criteria state "a 409
refetches and retries once, reusing `useUserSettings`'s existing handling."
During this epic's build, that turned out to be only half true:
`useUserSettings`'s conflict branch re-read the settings document and then
**threw** "Settings were updated elsewhere. Please try again." — handing
recovery back to the user for a conflict the hook could have resolved
itself. The three pre-existing 409 tests in `useUserSettings.test.ts` all
mocked `api.patch` with `mockRejectedValue` (rejecting on *every* call), so
they passed identically whether the hook retried or merely re-read and gave
up — the suite could not distinguish "refetches and retries" from
"refetches and gives up." Fixed in commit `0e48e68`
(`fix(web): actually retry a 409 in useUserSettings instead of handing it
back`): the retry happens **inside** the 409 handler, against the version
the re-read just returned, because `updateSettings` is a `useCallback`
closed over the `settings.version` from the render that created it — an
immediate retry from outside would resend that same stale `If-Match` and
409 again. `readSettings` was changed to *return* the document rather than
only storing it, because `setSettings` is asynchronous and the fresh
version cannot be read back out of state within the same tick. Retrying is
safe here specifically because the body is a **merge** PATCH, not a
replacement: `updates` states only the fields this caller changed, so
re-applying them on top of whatever landed in between is the correct
resolution — a `PUT` could not be retried this way, which is why
`replaceSettings` remains the separate path for a caller that already holds
a fresh document. It retries exactly once, not in a loop: a second conflict
means something is writing continuously, and a hook that kept retrying
would hide that from the user forever.

## 8. The surfaces, and why `HomePage.tsx` is untouched

Four surfaces read the same two checklists through one provider
(`OnboardingContext.tsx`, mounted once in `Layout.tsx` inside
`ProtectedRoute`) and render through one shared component
(`SetupChecklist.tsx`), so an administrator navigating between pages sees
one answer rather than four independent fetches that could disagree.

### 8.1 The shell banner, not a section of Home

`OnboardingBanner.tsx` mounts in `Layout.tsx`'s `<main>` beside
`MaintenanceBanner` and `NotificationPermissionBanner` — the third component
in this application that renders `null` for most users and sits above every
page. Two independent reasons rule out Home specifically. First, it would
break Home's request contract: `HomePage.tsx`'s binding rule is one request
per content type, fired in parallel, and `HomePage.test.tsx` asserts an
exact three-request `EXPECTED_REQUESTS` set that a checklist fetch would
grow to four. `HomePage.tsx` and `HomePage.test.tsx` are **unmodified** by
this epic — the test renders `HomePage` without `Layout`, so the banner
never mounts there and the assertion is not merely still passing, it is
still about the same three requests it always was. Second, Home is not
where a user is when they abandon the flow: an entry point there is
something to navigate *back* to, and the BYOK research this epic leans on
records exactly this failure mode, where leaving the flow to fetch a
provider key made the flow appear to have reset.

When an administrator has both checklists outstanding, the **admin** banner
wins — a deployment that cannot transcribe is a more urgent fact than an
unset display name, and stacking two banners above every page is noise for
no gain, since the user checklist stays reachable at
`/settings/getting-started` either way. Dismissal writes
`dismissedAt`/`adminDismissedAt` and the banner never reappears when the
registry gains a step later — those timestamps record a decision about
*the checklist*, not about a particular set of steps, and re-showing it
because a release added `admin.push` would make every upgrade feel like a
regression to an administrator who already dismissed it once.

### 8.2 Two registry cards, not two free routes

`Setup` (`apps/web/src/config/adminSections.tsx`, first card in `General`,
gated on `system_settings:read`) and `Getting Started`
(`apps/web/src/config/userSettingsSections.tsx`, first card in `Account`,
no permission field, matching every other card in that registry) are both
Settings UI Pattern rule 1 registry entries, not routes left to find their
own way — a route without a card is one the hub, the Console rail and the
AppBar title resolver all disagree about, because none of the three has any
way to learn it exists. Both fall under prefixes `destinations.ts` already
owns (`/admin/*` via the pinned `console` destination, `/settings/*` via
its own prefix), so `destinations.test.ts` and `settingsRegistry.test.ts`
are green with no edit.

`SetupPage.tsx` (`/admin/settings/setup`) links every step out to its real
destination rather than embedding six settings forms in a wizard — the
Settings UI Pattern's rule 4 applied one level up, and the destination pages
already have better empty states than a wizard step would reproduce. The
one exception is `admin.access`, inlined as an "Invite somebody" field
reusing `components/admin/AddEmailDialog.tsx` unchanged: it is one text
field, and it is the only step whose destination page (`Users & Allowlist`)
is about *managing* access rather than granting it for the first time.

`GettingStartedPage.tsx` (`/settings/getting-started`) carries the one
piece of copy this whole issue exists for — a short BYOK explainer *above*
the checklist stating the key is the user's own, billed to their own
account, with no deployment key stored — because it has to be readable
*before* the user needs it, not beside the `user.ai_key` row where it would
arrive at the same moment `AiKeyRequired` would have. It offers no "set up
transcription" shortcut on a blocked step the way `NewTranscriptButton`
does for administrators: an ordinary user cannot act on that link, and a
button leading to a 403 is worse than a sentence naming who can.

### 8.3 The welcome dialog: three panes, replayable, not a gate

`WelcomeDialog.tsx` exports `FirstRunWelcomeDialog`, mounted in `Layout.tsx`
beside the banner, opening once when `onboarding.welcomeSeenAt` is absent.
Three panes and not a fourth: the product's thesis in one sentence, the
BYOK fact in one pane on its own (the reason the dialog exists at all), and
a button to whichever checklist applies. `Skip` sits at the same visual
weight as `Next` — a discouraged dismissal is a dismissal the design is
working against, on a product still being evaluated. Closing by any
route — Escape, the close button, a backdrop click, `Skip`, finishing pane
3 — writes `welcomeSeenAt` and the dialog never reopens on its own,
including after the registry later gains a step, for the identical reason
the banner does not.

`GettingStartedPage.tsx`'s "Replay the intro" reopens the same dialog
**without** clearing `welcomeSeenAt` — the split between a controlled
replay and the shell-mounted first-run host is why `WelcomeDialog.tsx`
exports two components rather than one with a `replay` flag. Clearing the
timestamp on replay would mean watching it once, deliberately, made it
ambush the user again next session, which reads as a bug rather than a
feature.

### 8.4 The return-to-setup bar

Every step links **out**, and the BYOK onboarding research this epic cites
records what happens next in the ordinary case: the user leaves for a
vendor console, comes back, and the flow appears to have reset — in the
reported case, saved keys looked wiped because a wizard simply reopened
blank. `ReturnToSetupBar.tsx` is the thread back: mounted once in
`Layout.tsx`, it reads `?setup=<stepKey>` from the URL (appended by
`onboardingPaths.ts`'s `withSetupReturn`), shows which step is in progress,
links back to the hub the step's `audience` names, and calls `refresh()` on
arrival so the status shown is current rather than whatever was cached
before the user left.

⚠ An **unrecognised** `?setup=` value renders nothing, always. It is
user-controllable URL input, and the raw parameter is never rendered in any
branch — everything the bar shows (a step's title, its `href`) comes from
the checklist the server already returned, found by looking the key up, so
there is no path by which a string typed into the address bar reaches the
DOM. The three cases that fold into "nothing" are the same case: a key
matching no step, a key belonging to the *other* audience's checklist (for
which there is no state to search, since that checklist was never fetched
for this caller), and a malformed or oversized value.

### 8.5 Skipping is reversible, and required steps cannot be skipped

`skippable: false` on every `required` step means `requiredRemaining` and
`allRequiredSatisfied` can never be silenced by a user waving away a
warning about a deployment that genuinely does not work.
`SetupChecklist.tsx` renders an **Undo** on any row the server returned
`skipped: true`, which is the entire reason `GET /api/onboarding` and `GET
/api/admin/onboarding` return skipped steps rather than filtering them out
(§6) — a skip a user cannot reverse is a decision made once, permanently,
from a row that may have been clicked by accident.

## 9. Accessibility

Accessibility is asserted throughout this epic, not assumed from the
component library underneath it. Modals in particular fail the same three
WCAG criteria in most of the wild — over 70% of pages carrying a modal fail
at least one of: focus never moved into the dialog, no keyboard escape, and
a screen reader never told that a dialog opened — which is why
`WelcomeDialog.test.tsx` asserts each one **separately** rather than
trusting that MUI's `Dialog` supplies all three by default: `role="dialog"`
with `aria-labelledby`/`aria-describedby` resolving to real elements
carrying text, focus trapped while open, focus **restored** to whatever was
focused before the dialog opened, and Escape closing it.

`SetupChecklist.tsx` carries the rest of the requirement:

- **Status is words, never colour or icon alone.** `Done` / `Not set up` /
  `Waiting on your administrator` are the accessible name of a step's
  status; every icon is `aria-hidden` decoration on top of the words, never
  a substitute for them.
- **A blocked step's reason is associated, not merely nearby.** The action
  is `disabled` and `aria-describedby` points at the visible sentence
  naming who has to act — a disabled button with an unassociated
  explanation two lines below announces as nothing more than "dimmed."
- **One real `<ol>` of `<li>`s**, tiers kept contiguous (required first)
  rather than split into three separate lists — three lists would each
  reset a screen reader's position count to "1 of 2," losing any sense of
  how much is left overall.
- **Progress carries a text equivalent beside the bar**, never only an
  `aria-label` — a bar is not a number, and a number hidden inside a label
  is a number a sighted user cannot read either.

`SetupChecklist.test.tsx`'s "the breakpoint-gate rule" suite greps every
onboarding component, context and page's source for `useMediaQuery` and
fails if it finds one: CLAUDE.md's Settings UI Pattern rule 5 fixes the
five coupled breakpoint gates permanently at five, and every responsive
decision in this epic is an `sx`/`Grid` breakpoint object resolved in CSS
instead, for that reason.

## Rejected alternatives

- **A blocking modal wizard.** Rejected at the epic level: front-loading
  friction is the most common onboarding failure, and a modal a user cannot
  dismiss on a product they are still evaluating is where evaluation stops
  (§2, §8.3).
- **A tour/coach-mark library** (`react-joyride`, `intro.js`, `shepherd`,
  `driver.js`). Rejected on the research in §2 and on this repo's standing
  preference for reusing parameterised components over adding a dependency
  for a list MUI's own `Stepper`/`Dialog` already render adequately.
- **Embedding the transcription/AI/email/push settings forms inside the
  setup wizard.** Rejected: six forked forms, six places to drift from the
  pages they copy, and the destination pages already have better empty
  states than a wizard step would reproduce — the opposite of the Settings
  UI Pattern's rule 4 applied one level up (§8.2).
- **Persisting per-step completion as a boolean, the first time it is
  observed satisfied.** Rejected: wrong in the direction that matters — a
  green tick over a broken deployment rather than a spurious to-do — and it
  turns every later configuration change into a stale record with no repair
  path (§3).
- **One merged endpoint serving both checklists**, with the admin half
  empty for non-admins. Rejected: the exact partial-answer shape
  `HomePage.tsx`'s header already rejects for `GET /api/home/summary`, and
  worse here — an empty admin-steps array is indistinguishable from
  "nothing left to do," so a Viewer would be shown what looks like a fully
  configured deployment (§6).
- **A single route with `?audience=`.** Rejected: the gate would then
  depend on a query string rather than on the route, exactly the property
  the two-prefix split (mirroring `/api/nodes` ÷ `/api/admin/nodes`) exists
  to avoid (§6).
- **Inlining the checklist into `JourneyEmptyState`** on Home. Rejected on
  three independent grounds: it breaks Home's exact three-request
  assertion, it is not where a user is when they abandon the flow, and it
  would dilute a component whose own header argues carefully for exactly
  four cards answering "what is this product" — a different question from
  "what is missing from your account" (§8.1).
- **A browser-notifications onboarding step.** Rejected at the epic level:
  `NotificationPermissionBanner` already asks for this at the shell level,
  and the OS permission is a client-only fact the server has no way to
  report.
- **A new `onboarding:read` permission.** Rejected: epic #118 decision 8's
  precedent (the About card) already establishes that this class of read is
  an administrator's configuration read, not a new authority, and a new
  string would cost a seed migration plus two test-fixture edits for a gate
  that is a synonym for `system_settings:read` (§6).
- **An `onboardedAt` column on `users`.** Rejected: it is a migration for
  what is genuinely per-user JSONB preference, and it would split "what
  this user has decided" across two stores instead of one (§7).
- **`localStorage` for onboarding state.** Rejected: state that does not
  follow a user to a second device or browser is state that re-runs there,
  and a welcome dialog reappearing on every new device is precisely the
  annoyance the research in §2 says drives dismissal (§7).
- **Polling for state changes.** Rejected: onboarding state changes when
  the user does something and the user is standing right there when they
  do it; a background poll on every page of the shell, for the tab most
  likely to be left open all day, buys nothing a `refresh()` on the surface
  that cares does not already buy. The one case that looks like it needs
  polling — an administrator finishing setup in a second tab — is exactly
  the case `refresh()` on remount already handles (§7, §8.4).
- **Two `SetupChecklist` components, one per audience.** Rejected: the
  rendering is identical, so the second implementation exists only to be
  kept in step with the first, and it is reliably where the accessibility
  work gets skipped (§8).
- **Letting a step run its own query behind a memo.** Rejected: memoisation
  makes the cost *usually* bounded, a different property from bounded, and
  the day someone adds a step with an un-memoised read no test fails to
  say so (§4).
- **A `satisfied: boolean` instead of three statuses.** Rejected: it forces
  the UI to invent its own "why not" logic from whatever fields remain,
  the exact conflation `ai-config.dto.ts` already refuses (§5).
- **Mounting `OnboardingProvider` in `App.tsx` above `ProtectedRoute`.**
  Rejected: every endpoint it calls is `@Auth()`-guarded, so mounting it
  over `/login` and `/activate` would buy a guaranteed 401 on the two
  routes where nobody is signed in yet.
- **Adding `ReturnToSetupBar` to each destination page individually.**
  Rejected: eight (and growing) copies to keep in step, eight places for
  the "back" link to drift from the audience that actually owns a step, and
  the query parameter is already shell-level state the bar can read once
  (§8.4).
- **A new `onboarding.welcome` notification event for the welcome email's
  CTA.** Rejected: `user.welcome` already exists, fires exactly once by
  construction, and is already enabled by default — a second event would be
  a second thing for a user to have to mute.
- **Clearing `welcomeSeenAt` on replay.** Rejected: replaying the intro
  once, deliberately, would then make it auto-open again next session,
  which reads as a bug rather than a feature (§8.3).
- **Hiding the Setup card once every required step is satisfied.**
  Rejected: a card that vanishes is a card an administrator cannot use to
  confirm the deployment is *still* healthy, and the checklist's entire
  value is that its status is derived live rather than cached (§3, §8.2).

## Verification

| Claim | Where it is asserted |
|---|---|
| A `required` step is never `skippable`; every `permission` matches a real permission constant, not a string invented in the test | `apps/api/src/onboarding/onboarding.service.spec.ts` ("the registry") |
| Each step function takes `ctx` as its only argument, mutates nothing, and reads no collaborator | `apps/api/src/onboarding/onboarding.service.spec.ts` ("step purity") |
| Adding a user or an admin step changes the number of reads issued by zero | `apps/api/src/onboarding/onboarding.service.spec.ts` ("bounded read count") |
| The user route never reads an admin-only fact | `apps/api/src/onboarding/onboarding.service.spec.ts` ("bounded read count") |
| Transcript/note counts exclude soft-deleted rows; a user whose only transcript is soft-deleted is not activated | `apps/api/src/onboarding/onboarding.service.spec.ts` ("content counts") |
| `admin.transcription` goes back to `pending` when the credential is removed, with nothing cleared (derived, never stored) | `apps/api/src/onboarding/onboarding.service.spec.ts` ("admin.transcription") |
| `admin.smoke_test` stays `satisfied` after the provider is later disconnected — the test did happen; `blocked` naming the step that has to land first while nothing is connected | `apps/api/src/onboarding/onboarding.service.spec.ts` ("admin.smoke_test") |
| `user.ai_key` is absent with no vendor named, and `pending` — never `blocked` — while a vendor is named but AI is off (issue #83) | `apps/api/src/onboarding/onboarding.service.spec.ts` ("user.ai_key") |
| `user.first_transcript`/`user.first_note` block with a reason naming the administrator, in the correct order | `apps/api/src/onboarding/onboarding.service.spec.ts` ("user.first_transcript", "user.first_note") |
| A zero-permission user gets 200 with `audience: "user"` from `GET /api/onboarding`, and 403 from `GET /api/admin/onboarding` | `apps/api/test/onboarding/onboarding.integration.spec.ts` |
| A Viewer's request never causes `EmailSettingsService`/`PushConfigService`/account counts to be read — asserted with spies | `apps/api/test/onboarding/onboarding.integration.spec.ts` ("never reads an admin-only fact...") |
| A step whose destination permission the caller lacks is absent, not disabled; the response never publishes the permission a step guards | `apps/api/test/onboarding/onboarding.integration.spec.ts` |
| A skipped step is returned, marked, and counted out of `requiredRemaining`/`totalRemaining`; `requiredRemaining` counts only unsatisfied `required` steps | `apps/api/test/onboarding/onboarding.integration.spec.ts` |
| The admin route derives status on every read — nothing is stored and nothing is written | `apps/api/test/onboarding/onboarding.integration.spec.ts` ("derives status on every read...") |
| The `onboarding` namespace is declared identically across all six sources, with no `.default()` anywhere, and is absent from `DEFAULT_USER_SETTINGS` | `apps/api/src/common/schemas/user-settings-parity.spec.ts` |
| A `PATCH` round-trips `welcomeSeenAt`, a per-field `null` clears one field and leaves the others, and an emptied namespace collapses back to absent | `apps/api/test/settings/user-settings.integration.spec.ts` |
| `.strict()` rejects a misspelt field; PUT/PATCH null asymmetry; `skipped` bounds enforced exactly at the cap | `apps/api/src/settings/dto/update-user-settings.dto.spec.ts` |
| `OnboardingProvider` issues one `GET /api/onboarding` on mount, and `GET /api/admin/onboarding` only for a holder of `system_settings:read` | `apps/web/src/__tests__/contexts/OnboardingContext.test.tsx` ("the admin gate") |
| `dismiss`/`skip`/`unskip`/`markWelcomeSeen` each issue exactly one PATCH touching only `onboarding` | `apps/web/src/__tests__/contexts/OnboardingContext.test.tsx` ("writes") |
| No timer, interval or polling hook anywhere in the provider | `apps/web/src/__tests__/contexts/OnboardingContext.test.tsx` ("the no-polling rule") |
| A re-read and a genuine retry (second PATCH, fresh `If-Match`) are distinguished, and the retry happens exactly once | `apps/web/src/__tests__/hooks/useUserSettings.test.ts` ("Version Conflict Handling (409 errors)") |
| Status is rendered as words, not only icons or colour; a blocked step's action is disabled with its reason associated via `aria-describedby` | `apps/web/src/__tests__/components/onboarding/SetupChecklist.test.tsx` |
| No `useMediaQuery` anywhere in this epic's components, context or pages | `apps/web/src/__tests__/components/onboarding/SetupChecklist.test.tsx` ("the breakpoint-gate rule") |
| `vitest-axe` is clean in every checklist state (loading, satisfied, blocked, skipped) | `apps/web/src/__tests__/components/onboarding/SetupChecklist.test.tsx` ("accessibility") |
| The dialog's role/name/description resolve to real elements; focus is trapped while open and restored on close; Escape/close-button/backdrop/Skip all close it and write `welcomeSeenAt` | `apps/web/src/__tests__/components/onboarding/WelcomeDialog.test.tsx` |
| "Replay the intro" reopens the dialog without clearing `welcomeSeenAt` | `apps/web/src/__tests__/components/onboarding/WelcomeDialog.test.tsx` ("FirstRunWelcomeDialog") |
| An unrecognised, malformed or other-audience `?setup=` value renders nothing, and the raw parameter is never echoed | `apps/web/src/__tests__/components/onboarding/ReturnToSetupBar.test.tsx` |
| `refresh()` fires on arrival with a marker, and "Next step" appears only once the named step flips `satisfied` | `apps/web/src/__tests__/components/onboarding/ReturnToSetupBar.test.tsx` |
| The admin banner wins over the user banner when both are outstanding; dismissal writes the correct field and disappears before the PATCH resolves | `apps/web/src/__tests__/components/onboarding/OnboardingBanner.test.tsx` |
| The `Setup` card is first in `General`, declares `system_settings:read`, and is not an `alwaysShow` escape hatch | `apps/web/src/__tests__/pages/Admin/SetupPage.test.tsx` |
| The `Getting Started` card is first in `Account` and declares no `permission`, like every card in that registry | `apps/web/src/__tests__/pages/GettingStartedPage.test.tsx` |
| The BYOK explainer renders above the checklist and states all three facts | `apps/web/src/__tests__/pages/GettingStartedPage.test.tsx` ("the BYOK explainer") |
| A blocked step on the getting-started page offers no administrator shortcut | `apps/web/src/__tests__/pages/GettingStartedPage.test.tsx` |
| `HomePage.test.tsx`'s exact three-request `EXPECTED_REQUESTS` assertion is unmodified by this epic | `apps/web/src/__tests__/pages/HomePage.test.tsx` (unchanged; see the file's own git history) |

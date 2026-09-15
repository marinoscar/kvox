# The UX Refresh

> Epic #105 (issues #106–#113): giving Transcripts and Notes their own
> top-level destinations, splitting Console off the bottom bar to make room
> for them, adding Notes to the home page, a per-line "play this segment"
> control (and fixing the transport's 15-second skip to match what it always
> drawn), a Regenerate dialog that can actually change what it regenerates,
> and an indigo/amber brand palette and K-and-waveform mark with their
> contrast measured rather than eyeballed. Implemented across
> `apps/web/src/config/destinations.ts`, `apps/web/src/components/library/`,
> `apps/web/src/pages/HomePage.tsx`, `apps/web/src/hooks/usePlaybackEngine.ts`,
> `apps/web/src/components/notes/`, `apps/web/src/theme/tokens.ts`,
> `apps/web/src/utils/transcriptDisplay.ts`, and
> `apps/web/scripts/generate-icons.py` plus the two hand-written brand SVGs.
> Issue #113 — this document — is the epic's last, per CLAUDE.md's
> Issue-Driven Development rule that documentation lands after the code it
> describes, the same position `docs/specs/notes.md`'s own issue #60 occupies
> for epic #45.
>
> This document explains **why** each of the six pieces below is shaped the
> way it is, and names the alternatives that were tried or considered and
> rejected. It is not a restatement of `CLAUDE.md`'s "Navigation destination
> model" subsection, which states the rule; this is the rationale that
> subsection defers to, the same relationship `docs/specs/settings-ui.md` has
> to the "MANDATORY: Settings UI Pattern" section.

## 1. Navigation model

Five destinations — `home`, `transcripts`, `notes`, `settings`, `console` —
declared once in `apps/web/src/config/destinations.ts`'s `DESTINATIONS`
array, which every navigation surface (the rail, the bottom bar, the user
menu) reads instead of keeping its own list. `BOTTOM_BAR_DESTINATIONS` is
**derived**, never a second hand-written array: it is every destination for
which `pinned` is falsy, currently four (`home`, `transcripts`, `notes`,
`settings`). That derivation is the whole point — the bar's ceiling and the
model's promise are the same statement, not two statements a future edit
could let drift apart.

### `pinned` means a mode, not a peer

`console` is the one destination with `pinned: true`, and the flag names a
real distinction rather than a rendering quirk: Console is an operator
**mode** a user switches into, not a fifth thing this application is for in
the way Home, Transcripts, Notes and Settings are. Each surface draws a mode
differently because each surface has a different place to put one:

- The **rail** relocates it to its own foot, below a divider (issue #105).
- The **user menu** lists it inline with the rest, because a flat menu has no
  foot to pin to and no room to invent a second group for one row.
- The **bottom bar omits it entirely.** A bar has no foot either — it *is*
  the foot — so there is nowhere to put a pinned row that would not read as a
  fifth peer destination. Console stays reachable below `sm` through the
  avatar menu, the same place a phone user reaches every other
  non-destination control.

### Why the collapsed rail is 72px, not 56px

`RAIL_WIDTH_COLLAPSED` moved from 56 to 72 as a direct consequence of this
epic, and the reason is a specific caption, not a general tightening. Issue
#105 (the pinned-foot rework, immediately before this epic's destination
split) deliberately *kept* the rail at 56px and found its room instead by
reclaiming 8px of a row's own padding — enough for the captions that existed
then ("Settings", "Console"), which measured roughly 41px against a 48px
interior box. Splitting `transcripts`/`library` into two destinations (§1's
own history, below) introduced an **eleven-character** caption,
"Transcripts", measuring roughly 54px in Inter at the rail's 0.625rem
caption size (57px in the widest sans-serif fallback with letter-spacing).
No amount of padding reclaimed from a 56px rail produces a box that holds an
11-character word — 48px was already the whole interior at 56px total.

Two narrower fixes were considered and rejected:

- **Abbreviate the caption** ("Audio", "Recs"). Rejected because a caption's
  one job is to name the destination it fronts, and an abbreviation would
  name something else — a reader scanning a collapsed rail for "the
  recordings" should not have to learn that "Audio" is where that lives.
- **Drop the caption entirely**, leaving a column of icons. Rejected for the
  same reason `NavigationRail.tsx`'s Console-mode comment already argues
  against it elsewhere: a column of near-identical unlabelled icons is
  exactly the failure a caption exists to prevent.

72px is still 8px under Material 3's own 80dp navigation-rail spec while
holding the app's longest destination name, so the fix widens the box to fit
the word rather than shrinking the word to fit an arbitrary box.

### What #106 undid, and put back with room to spare

Between issue #57 (epic #45) and issue #106 (this epic), Notes did not have
its own destination. #57 needed somewhere to put it, found the bottom bar
already holding four labelled actions, and renamed `transcripts` to
`library` so a single row could own both `/transcripts` and `/notes` —
fronted by a Transcripts | Notes tab strip that did the real navigating one
level down. That kept the bar's count at four, at the price of spending the
app's two primary nouns on a row named after neither of them: a user moving
between recordings and notes now moved between two *tabs*, under a label
("Library") that describes neither.

Issue #106 pays that back by spending Console's bar slot instead of merging
Transcripts and Notes onto one row. Moving Console to the rail's foot (and
the user menu) frees exactly the fourth bar slot #57 was short by, so
`transcripts` and `notes` become two full, independently-lit destinations —
`DESTINATION_ROUTES`'s `transcripts: ['/transcripts']` and
`notes: ['/notes']` — each gated on the one permission its own controller
enforces (`transcripts:read`, `notes:read`) rather than sharing an
`anyPermission: ['transcripts:read', 'notes:read']` the way the merged
`library` row had to. A deployment that revokes `transcripts:read` and keeps
`notes:read` now loses exactly the Transcripts row and keeps Notes — the
outcome the merged row's "or" gate could only fake with one row that stayed
visible either way.

**This is not a violation of `CLAUDE.md`'s Settings UI Pattern rule 2** ("a
settings page must not be added as a new tab on an existing settings page").
That rule permits tabs for genuinely parallel content — it never *requires*
a tab strip merely because two things are related. #57 chose tabs because
the bottom bar had no room for a fifth action at the time; this epic made
room by relocating Console, and once there was room, Transcripts and Notes
became what they always were underneath the tab strip: two answers to two
different questions ("what did I record" and "what did the AI write for
me"), each worth a destination of its own. `docs/specs/settings-ui.md` §2's
destination-vs-tab distinction — reachability versus content — was never in
tension with either design; it explains why *both* were defensible at the
time they shipped, and why the second is the better fit now that the
bottom bar's arithmetic changed.

### Rejected alternatives

- **An "Audio" caption for the Transcripts row**, to fit the pre-#106 56px
  rail without widening it. Rejected: see above — it misdescribes the row.
- **A fifth bottom-bar tab.** Rejected outright: `BOTTOM_BAR_DESTINATIONS`'s
  own header states the arithmetic — four labelled actions fit a 360px
  phone; five do not, without an overflow menu or unlabelled icons, either
  of which is a redesign of the bar, not an addition to it.
- **A per-surface `surfaces: readonly ('rail' | 'bar' | 'menu')[]` field**,
  generalising `pinned` into three independent booleans. Rejected because it
  admits eight states for a distinction this app draws exactly once, six of
  which are nonsense ("in the bar but not the menu") and nothing would
  reject them. `pinned` names the one real distinction — mode versus peer —
  and lets each surface decide what that means for itself.

## 2. Home composition

The rule, stated in `HomePage.tsx`'s own header and worth restating here
because every future addition to the page has to keep it true: **one
request per content type, all fired in parallel, none waiting on another,
and no per-section list fetches.** Before issue #107 that was one content
type (`GET /api/transcripts/summary`); #107 adds a second
(`GET /api/notes/summary`), and the page now fires both on mount through
`useTranscriptSummary`/`useNoteSummary` rather than one waiting on the
other, and rather than either hook growing its own further per-section
request (`RecentNotes` must never gain its own `GET /api/notes?limit=8`).

**A single aggregate `GET /api/home/summary` was considered and rejected**,
and the reason is authorisation, not plumbing. `transcripts:read` and
`notes:read` are two different permissions — both seeded to all three
roles, but neither implies the other, and a deployment is free to withhold
either independently. One endpoint spanning both would have to answer
*partially* for a user holding one of them: either a 200 carrying half the
body behind some new per-section "you may not see this" marker invented for
a single page, or a 403 hiding the half they are entitled to. Either is a
new authorisation shape owned by a page, when this codebase already has one
permission string per controller for exactly this reason.

The second reason is cadence, and it compounds the first: each hook polls
only while its own list has something in flight, so a transcript still
transcoding polls every five seconds while a settled Notes list costs
nothing. A merged endpoint has one poll interval, and it would necessarily
run at whichever content type's cadence is faster — re-reading the quiet
half of the page forever, on the one screen most likely to be left open
overnight.

## 3. Segment playback

Issue #108 adds a play/pause control to every transcript row (`SegmentList`)
that plays exactly that line and stops at its end, layered over the single
continuous stream `usePlaybackEngine` already drives for per-speaker
filtering (`docs/specs/transcription.md` §7.2). Everything about how it
behaves follows from one idea: the user pointed at a specific line, so
nothing may quietly move them off it.

### The boundary check is `if/else`, not two independent checks

`handleTick` — the one function both the `requestAnimationFrame` loop and
the backgrounded-tab `timeupdate` fallback call — tests segment mode and the
speaker-filter interval logic as an `if (seg) { … } else if (windows.length
> 0) { … }`, never as two sequential `if` blocks. Segment mode and the
speaker filter are mutually exclusive on purpose: a line the filter would
otherwise exclude is still a line the user explicitly asked to hear, and
letting the interval branch run underneath segment mode would seek straight
back out of the line on the very first tick after `playSegment` set the
position — the one case where "play this line" would visibly do nothing.

### Everything below the branch runs on every tick, segment mode included

The obvious way to write the boundary check is an early `return` once
segment mode's pause-and-park fires. `handleTick`'s own comment marks this
the failure to avoid: an early return would freeze the published position
and the current-segment index for the *entire length of the line being
played* — the two pieces of feedback (the scrubber moving, the active line
highlighted) that tell the user the button did anything at all. So the
~4 Hz position publish and the binary-search current-segment lookup run
unconditionally after the segment/interval branch, whether or not that
branch just parked the audio on a boundary.

### What ends segment mode

Every ordinary transport action — scrubbing, skipping, tapping a timestamp,
stepping to the previous/next segment, Space, the transport's own
play/pause — ends segment mode, because every one of them reaches either
`seekToMs` or `pause`, and that is where `clearSegmentPlay` is called from.
No caller carries its own copy of the clearing logic. A Media Session `play`
from a lock screen also resumes *ordinary* playback (through `play` →
`seekToMs`) rather than staying inside the one line, because a hardware key
has no way to express "and stay inside the line" — resuming the recording is
the less surprising of the two available answers, and it is documented
rather than special-cased.

### Why `playSegment` writes `currentTime` directly

`seekToMs` snaps any position outside the current speaker filter's windows
to the nearest allowed one. Routing `playSegment` through it would mean "play
this line" does nothing audible whenever the line's own speaker happens to
be filtered out — precisely the case where a "hear this one" button is most
useful, since the user is looking at a line the filter is otherwise hiding
from playback. `playSegment` therefore bypasses `seekToMs` and writes
`audio.currentTime` directly, which is also why segment mode has to be its
own tracked state rather than merely "wherever the intervals say we are."

### The emergent behaviour a test pins

There is one documented case where the boundary parks and then immediately
un-parks, and it is not a bug in either mechanism — it falls out of the
`if/else` above rather than out of segment mode's own logic. When a speaker
filter is active and the played line is that speaker's **last** line, its
`endMs` can fall outside every window the filter allows (the filter's last
window ends where that speaker's second-to-last line ends, not where their
last line does). The tick pauses and parks exactly as the unfiltered case
does — segment mode has, at that instant, just cleared itself — and on the
**very next tick** the interval branch (now active again, since segment mode
is gone) finds the parked position outside every window and pulls the
playhead to the nearest allowed one, the same reassertion any ordinary seek
into a filtered gap produces. This is the filter reclaiming the playhead,
not the parking logic failing, and
`apps/web/src/__tests__/hooks/usePlaybackEngine.test.tsx`'s *"lets the
speaker filter reclaim the playhead once the line has ended"* pins exactly
this sequence: park on the boundary first (`audio.paused === true`,
`currentTime` at the line's `endMs`), then one more tick moves the position
to the filter's actual last allowed instant.

### The 40px button versus the deliberately-small 24px timestamp

`SegmentList.tsx` gives the new play/pause control a 40px hit target — a
thumb-sized coarse control, deliberately the *first* thing in the row — set
against negative margins so it claims that hit area out of the row's own
padding rather than growing the row. The existing "play from here and keep
going" timestamp beside it stays a precise 24px control, below the 44px
touch-target guideline **on purpose**: the whole row is not a button (it
must stay selectable text, both for copying and for issue #31's in-place
editing), so the timestamp is deliberately small and precise, with the new
button and the player's own transport as the coarse alternatives beside it.

## 4. Generation context and the regenerate form

Issue #109 does two things to `POST /api/notes/{id}/regenerate`, and the
first is that **no API change was needed for either**: the endpoint has
accepted `{ templateId?, contextText?, model? }` since issue #53, and until
this issue the web client only ever sent `{}` — every regeneration was "do
the same thing again" by construction, because there was no control that
could ask for anything else.

### The regenerate dialog sends a diff, not a snapshot

`apps/web/src/components/notes/regenerateInput.ts`'s `buildRegenerateInput`
is pure and takes the note's own three stored values plus the form's three
string values, and its output is a **diff**:

- An unchanged field is **omitted** — a note whose template has since been
  archived would otherwise have its `templateId` re-asserted against a row
  the API may refuse, and a `model` the deployment no longer permits would
  be re-sent by a form that merely displayed it.
- Context is the one field with **three** states, matching the API's own
  three: unchanged is omitted, an explicit clear (the trimmed form value is
  empty while the note had text) sends `contextText: null`, and anything
  else sends the trimmed string. `null` is a **value** here, not an absence
  — a user who selects the context text and deletes it is asking for the
  third state, and a builder that treated "empty" as "omit" would silently
  regenerate with the very context they just removed.
- The no-change case produces `{}`, byte-for-byte the request the dialog
  sent before issue #109 existed — which is what lets the feature ship
  without changing what an unchanged "Regenerate" does.

### The 409 `template_required` response is a question, not a failure

When a note's template row has since been deleted, the API answers `409`
with `details.reason: 'template_required'` rather than guessing a
replacement. `NotePage.tsx`'s handler treats this distinctly from every
other regenerate failure: the dialog **stays open**, the error renders
inline against the Template field the user is already looking at, and
nothing about the rest of the form is disturbed — closing the dialog to
show this as a page-level error would put the question ("which template?")
and the one control that can answer it on different screens.

### Model choices come from the deployment's own capability probe

The dialog's model select is populated from `GET /api/ai/config`, the same
capability probe every other AI-key-aware surface in this application reads
(`docs/specs/notes.md` §2.5), never a list baked into the dialog. A
recorded model an administrator has since un-permitted is named explicitly
rather than silently swapped: the dialog shows *both* "the model this note
used is no longer permitted" and which model will be used instead, because
naming only one of the two would leave the user unable to tell what they
are about to pay for.

### The context panel shows exactly `assemblePrompt`'s inputs, minus the source

`NoteGenerationContext.tsx` — "How this note was generated," collapsed by
default beneath `NoteProvenance`'s always-visible one-line summary — renders
one field per input `apps/api/src/notes/generation/prompt.ts`'s
`assemblePrompt` actually receives (`docs/specs/notes.md` §3.1):
`templateInstructions`, `templateOutputFormat`, `templateStructure`,
`templateTone`, `templateLength`, and `contextText`. The one input it
deliberately omits is `sourceText` — a transcript or another note can run to
tens of thousands of words, and the panel's job is to answer "what did I
tell the model," not to reproduce the source the user can already read on
its own page. It additionally names **which** source produced the note
(linked, where the source has a page of its own) and the model/provider
that generated it — two facts `assemblePrompt` itself never takes as
arguments but that a reader needs to make sense of the rest of the panel.
Every branch renders a *true* sentence about a template that can no longer
be read (deleted, archived, or simply no longer the caller's to see) rather
than a blank field, for the identical reason `NoteGenerationContext.tsx`'s
own header gives: a panel that drew an empty "Instructions:" row would be
asserting the template had none, a different claim from "we cannot see it."

## 5. Brand tokens

Issue #110 replaces two independently hand-maintained palette files
(`theme/light.ts`, `theme/dark.ts`) — which had already drifted, light
`primary.main` tracking the brand colour while dark `primary.main` was an
unrelated hardcoded `#90caf9` — with one token map,
`apps/web/src/theme/tokens.ts`'s `BRAND_TOKENS`, that both palettes are thin
translations of.

### The measured palette

Every ratio below is recomputed from the shipped literals by
`apps/web/src/__tests__/theme/tokens.test.ts` on every run — the numbers are
transcribed from that file's own comments, not independently calculated for
this document, per that file's own stated discipline of not letting the
comment and the assertion drift apart.

| Pair | Light | Dark |
|---|---|---|
| `text.primary` on `background.default` / `paper` | 15.82:1 / 16.93:1 | 15.42:1 / 14.20:1 |
| `text.secondary` on `background.default` / `paper` | 5.83:1 / 6.24:1 | 7.91:1 / 7.28:1 |
| `primary.main` on `background.default` / `paper` | 5.87:1 / 6.29:1 | 9.47:1 / 8.72:1 |
| `secondary.main` on `background.default` / `paper` | 4.69:1 / 5.02:1 (tightest) | 11.30:1 / 10.41:1 |
| `primary.contrastText` on `primary.main` | 6.29:1 (`#ffffff` on `#4f46e5`) | 9.47:1 (`#0f1117` on `#a5b4fc`) |
| `secondary.contrastText` on `secondary.main` | 5.02:1 (`#ffffff` on `#b45309`) | 11.30:1 (`#0f1117` on `#fbbf24`) |
| success / warning / error / info, on `paper` | 5.02 / 4.92 / 6.47 / 6.70 | 9.97 / 10.41 / 6.28 / 6.84 |
| Every speaker colour, worst case | 4.60:1 on `#f6f7fb` (index 6, `#a16207`); 4.92:1 on `#ffffff` | 10.41:1 on `#0f1117` (index 1, `#f9a8d4`); 9.58:1 on `#171a23` |

All of the above are held to the full 4.5:1 (`WCAG_AA_NORMAL_TEXT`), including
`primary.main`/`secondary.main`, which WCAG 1.4.11 would let off at 3:1 as
non-text UI components — deliberately stricter than the standard requires,
because in this application both colours are overwhelmingly used **as ink**
(link text, a selected bottom-nav label, a filter chip's label), and a
palette that only cleared 3:1 would make every one of those uses a violation
waiting for someone to reach for the colour the obvious way. `text.disabled`
is the one tier deliberately **not** held to 4.5:1 (light 2.88:1, dark
3.56:1 on `paper`) — WCAG 1.4.3 exempts inactive components, and a disabled
control that met AA would stop looking disabled; the property asserted
instead is that disabled is always fainter than secondary.

### Why light `primary.main` is `THEME_COLOR`, and dark is a sibling token, not a derivation

Light `primary.main` is `THEME_COLOR` itself (`#4f46e5`), imported from
`@app/shared`, rather than a copy of its value — `packages/shared/identity.json`
is the rebrand codemod's single field, read by `scripts/rename.mjs` and by
`generate-icons.py` to paint the committed PNGs, and the installed-app
surfaces those two touch (the manifest's `theme_color`, the icon rasters,
the two hand-written SVGs) execute no React and can never import a palette.
If the running theme's primary colour lived only in `tokens.ts`, a rebrand
could restyle the application while leaving the browser tab, the Home
Screen icon and the OS chrome on the old colour; importing `THEME_COLOR`
here makes that divergence structurally impossible instead of merely
avoided by discipline.

Dark `primary.main` is **not** derived from `THEME_COLOR` via MUI's
`tonalOffset`, even though letting `createTheme` lighten one shared value is
the obvious-looking alternative. It was rejected on measurement:
`THEME_COLOR` at AA against the dark paper `#171a23` is a non-starter
(2.76:1), and the tint `tonalOffset` would produce is a desaturated,
muddy blue-grey — `tonalOffset` mixes toward white in sRGB, which drags an
already dark, heavily saturated indigo through exactly the part of the
colour space where it loses its hue identity first. `#a5b4fc` is instead a
*chosen* tint from the same indigo ramp, picked to keep the hue legible
while clearing 8.72:1 on `#171a23`. The dark primary is therefore a design
decision recorded as one, beside the light value in the same object — which
is the entire remedy for the drift this token map replaces: both modes are
now physically adjacent, so a change to one is a change beside the other,
not a change nothing else in the repository can see.

### `elevated`: a tonal surface, not a shadow

`elevated` is a Material 3 tonal-surface-container colour — the ground a
dialog, menu, popover or the bottom navigation bar sits on. Material 2's
answer to "this floats above the page" is a drop shadow, which reads fine on
a light ground and fails on a dark one: a shadow *is* darkness, and there is
none left to spend below `#0f1117`. Material 3's answer is a **lighter**
surface instead — `#1e222d` in dark mode. In light mode `elevated` equals
`paper` (`#ffffff`) on purpose: white paper on the tinted `#f6f7fb` page
ground already reads as raised, so light mode keeps its own restrained
shadow and needs no second surface. Both modes carry the key regardless, so
`theme/components.ts` can reference `BRAND_TOKENS[mode].elevated`
unconditionally rather than branching per mode at every call site.

### Speaker-palette rules

`apps/web/src/utils/transcriptDisplay.ts`'s `SPEAKER_COLORS_LIGHT`/`_DARK`
carry three rules, restated here because each is easy to break from a
neighbouring file:

1. **Index order is data, not presentation.** `transcript_speakers.color_index`
   is persisted per speaker at ingest, so re-ordering either array — sorting
   by hue, moving a disliked colour to the end, inserting a ninth in the
   middle — silently recolours every speaker in every transcript that
   already exists, including ones a user has read, annotated and shared. A
   colour may be **replaced in place** (issue #110 did this eight times) or
   **appended**; nothing may move, and the two lists must stay the same
   length.
2. **Never the primary hue.** A speaker name drawn in the brand indigo reads
   as "selected," "active" or "link" — a tab indicator, a focus ring, a
   `<Link>` — and in the segment list, where a speaker's name sits directly
   above tappable text, it would read as a control the user already
   activated. `tokens.test.ts` checks this by **exact match** against the
   four indigos in the primary ramp, deliberately not by a numeric "how
   indigo is this" threshold: Euclidean RGB distance rejects `#7e22ce` (a
   purple 64 units from `#4f46e5` that reads as an entirely different hue),
   and hue-angle distance rejects `#475569`/`#cbd5e1` (near-neutral slates
   whose residual hue sits 17–28° from indigo while carrying almost no
   saturation to express it). A threshold loose enough to pass both of those
   would be loose enough to pass a genuine indigo — worse than no threshold,
   because it would read as a guarantee while guaranteeing nothing.
3. **≥ 4.5:1 on both surfaces of its own mode**, per the measured table
   above — the rule that mattered most in practice: the light list this
   replaced shipped `#e65100` (3.48:1) and `#00838f` (4.15:1) against the
   old `#f5f5f5` ground, both failing AA since the day they were written,
   neither ever noticed, because nothing measured a hex literal before this
   issue added a test that does.

⚠ `apps/api/src/transcripts/export/speaker-palette.ts` mirrors the **light**
list, value for value, for the PDF exporter — a monochrome-paper surface has
only one ground to satisfy. The two files must change together: the package
boundary (`apps/api` cannot import from `apps/web`, and there is no shared
package between them) means nothing but this comment and review keeps them
in step, and a drift would mean the same speaker renders one colour in the
web viewer and another in a PDF exported from the same transcript.

## 6. Brand mark geometry

The mark is a K monogram followed by a five-bar waveform, drawn as fractions
of its own bounding box in three places that must describe the same shape:
`apps/web/public/icons/source.svg`, `apps/web/public/favicon.svg`, and the
constants at the top of `apps/web/scripts/generate-icons.py`.

### The ratio table

| Constant | Value | Meaning |
|---|---|---|
| `MARK_ASPECT` | 0.7380 | Mark height as a fraction of its **width** |
| `STROKE_WIDTH_RATIO` | 0.1304 | Stem width and arm stroke alike |
| `JUNCTION_Y_RATIO` | 0.3690 | Where the arms meet the stem, down from the top |
| `ARM_END_X_RATIO` | 0.5043 | How far the arms reach across |
| `ARM_SPREAD_RATIO` | 0.2731 | Arm endpoints, above and below the junction |
| `BAR_X0_RATIO` | 0.4428 | First waveform bar's left edge |
| `BAR_PITCH_RATIO` | 0.1184 | Centre-to-centre spacing between bars |
| `BAR_WIDTH_RATIO` | 0.0836 | Each bar's width |
| `BAR_HEIGHT_RATIOS` | `(0.1808, 0.3346, 0.2866, 0.3346, 0.1808)` | Symmetric short/tall/medium/tall/short envelope |

⚠ **`mark_ratio` means the mark's *width*, not the side of a square box.**
Every ratio above is a fraction of that width, and the mark's height follows
from `MARK_ASPECT` — it used to mean the side of a square mark box, before
the waveform made the mark wider than it is tall, and a reader carrying the
old meaning forward will size every icon family wrongly. `draw_mark`'s own
docstring states this explicitly for exactly that reason.

### Three descriptions, one mark — and only one pair is checkable

`source.svg`, `favicon.svg` and `generate-icons.py` each draw the same
shape, and the duplication is deliberate: the generator draws with Pillow
rather than rasterising the SVGs, because rendering an SVG needs `rsvg` /
`cairosvg` / a headless browser — precisely the image-toolchain dependency
this template's committed-PNG approach exists to let a fork's CI avoid.
`apps/web/src/__tests__/pwa/brandMark.test.ts` can therefore only compare
**the two SVGs** to each other, normalised into each file's own mark-box
space (the two crops differ on purpose — 68% of canvas for the source art,
80% for the favicon, because at tab size the padding costs whole pixels the
arms need). The third description, the Python generator, is held in step
with the other two by review and by the shared constant names alone —
checking the generator's rasterised *output* against the vectors would need
exactly the rasterising toolchain the generator exists to avoid, so nobody
tests it and the discipline is "change the ratio in all three places, or
change none of them."

### Two corrections to the supplied artwork

1. **The middle bar was re-centred.** The supplied artwork had it sitting
   lower than its four neighbours while its *height* pattern was already
   symmetric (short, tall, medium, tall, short) — the asymmetric vertical
   position, with no corresponding asymmetry in height, is what says the
   offset was an artifact of how that image was produced rather than a
   design choice. An off-centre bar reads as a mistake at 16px, where most
   of this mark is actually seen.
2. **The pitch was regularised** rather than measured bar by bar. A constant
   `BAR_PITCH_RATIO` is what lands the last bar's right edge on exactly
   1.0 — `0.4428 + 4 × 0.1184 + 0.0836 = 1.0000` — which a set of five
   independently-measured gaps would not reliably do, and a bar that
   overshot the mark's own right edge would be clipped by the maskable safe
   zone on Android before it was ever noticed on desktop.

### Why round-capped diagonals, not stacked bars

The K's arms are drawn as two round-capped diagonal lines rather than
columns of short axis-aligned bars, and the reason is not aesthetic
preference but a first attempt that visibly failed: stacking short
rectangles (Pillow's easiest primitive) left a clear horizontal gap between
consecutive columns, so the bars never joined into a continuous diagonal —
they stayed six separate dots and the icon read as a domino, not a letter.
A round-capped diagonal is the smallest change that produces the actual
letter, and both toolchains draw one without difficulty: SVG with
`stroke-linecap="round"`, Pillow with a `line` (which gives butt ends) plus
a circle drawn at each endpoint to fake the same cap.

## 7. Visual-baseline policy for this epic

Three of the changes above — the rail's width (§1), the palette (§5), and
the mark (§6) — each touch nearly every existing Playwright visual-regression
screenshot: the rail's width shifts the position of everything beside it,
the palette recolours every surface in both themes, and the mark appears in
any screenshot that shows the AppBar or a favicon-scale element. Regenerating
baselines after each individual PR in this epic would mean fighting the same
repo-wide diff repeatedly — every intermediate commit's baselines would be
correct for that commit and wrong for the next one in the same epic, and a
reviewer would be asked to eyeball hundreds of pixel diffs that are really
one diff, several times over.

So baselines for this epic are regenerated **once, at the end**, after every
other piece has landed — not per PR — inside the same pinned Playwright
container `docs/TESTING.md` already specifies for this suite
(`mcr.microsoft.com/playwright:v1.62.1-noble`, via `tests/visual/package.json`'s
`npm run test:update`), never on a host machine, for the reason that
document already gives: pixel baselines are sensitive to the exact Chromium
build a Playwright version ships, not merely its API surface. The visual
specs this epic's navigation model touches directly
(`tests/visual/specs/home.spec.ts`, `console-rail.spec.ts`,
`library-rail.spec.ts`, `admin-hub.spec.ts`) are updated to exercise the
shipped destinations and rail width; regenerating their baselines is
deliberately out of this document's scope — it is the last step of the
epic, run once the code above is final, not a step this documentation
change performs.

## 8. Rejected alternatives

Gathered from the sections above, in one place:

- **An "Audio" caption** for the widened Transcripts row (§1) — misdescribes
  the destination it fronts.
- **A fifth bottom-bar tab** for Notes (§1) — does not fit a 360px phone
  without an overflow menu or unlabelled icons, either of which is a redesign
  of the bar.
- **A per-surface `surfaces: ['rail', 'bar', 'menu']` field** (§1) — admits
  eight states for one real distinction, six of them nonsense.
- **An aggregate `GET /api/home/summary`** (§2) — forces one endpoint to
  answer partially for a user holding one of two independent permissions,
  and forces both content types onto one poll cadence.
- **Routing `playSegment` through `seekToMs`** (§3) — would make "play this
  line" silently do nothing whenever the line's speaker is filtered out,
  exactly the case the button exists for.
- **An early `return` inside `handleTick`'s segment-mode branch** (§3) —
  would freeze the scrubber and the active-line highlight for the entire
  length of the line being played.
- **Deriving dark `primary.main` from `THEME_COLOR` via `tonalOffset`**
  (§5) — fails AA outright at the source colour, and the lightened tint
  `tonalOffset` produces desaturates toward grey rather than staying a
  legible indigo.
- **A numeric "how indigo is it" distance threshold** for the speaker-palette
  rule against reusing the primary hue (§5) — both Euclidean RGB distance
  and hue-angle distance were tried and each rejects a colour that should
  pass or passes one that should not.
- **Stacked axis-aligned bars for the K's arms** (§6) — the first attempt,
  and it read as a domino rather than a letter.
- **Comparing the generator's rasterised PNG output against the two SVGs**
  (§6) — would require exactly the SVG-rasterising toolchain
  (`rsvg`/`cairosvg`/a headless browser) the Pillow-based generator exists
  to let a fork's CI avoid.
- **Regenerating visual baselines after each PR in this epic** (§7) — the
  rail width, the palette and the mark each invalidate nearly every
  baseline, so incremental regeneration would mean re-fighting the same
  repo-wide diff at every intermediate commit.

## 9. Research sources

The palette (§5) and mark (§6) decisions drew on external design research
rather than being chosen by eye; recorded here as the sources consulted,
per this repository's convention of naming what an implementation-facing
decision was checked against (`docs/specs/transcription.md` §2.7 does the
same for AssemblyAI's own documentation):

- **atmos.style** — dark-mode design practices, in particular tonal-surface
  elevation as Material 3's alternative to a drop shadow (§5's `elevated`).
- **colorpick.app**'s dark-mode guide — tint selection for a saturated brand
  hue on a near-black ground, informing the rejection of a `tonalOffset`
  derivation in favour of a hand-picked dark `primary.main` (§5).
- **m3.material.io** — the colour-system and window-class-boundary
  documentation behind both this epic's tonal-surface treatment and the
  `sm` (600px) boundary `docs/specs/settings-ui.md` §5 already documents.
- **webaim.org**'s contrast checker — the WCAG 2.1 arithmetic
  `apps/web/src/__tests__/theme/tokens.test.ts` reimplements and runs on
  every commit (§5).
- **muz.li** — dark-mode design-system surveys, informing the elevation and
  text-tier structure of `BRAND_TOKENS.dark`.
- **evilmartians.com**'s writing on the OKLCH colour ecosystem — perceptual
  colour-space reasoning behind treating a dark-mode tint as a chosen
  design decision rather than a mechanical lightening of one shared value
  (§5).
- **brandfetch.com** — consulted for Otter, Fireflies and Notta's own marks
  and colour choices, as competitive context for a K-and-waveform mark that
  needed to read as this product category's kind of brand without copying
  any one competitor's specific shape.

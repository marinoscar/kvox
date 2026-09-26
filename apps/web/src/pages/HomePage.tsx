/**
 * `/` — the signed-in home page. Issue #32, epic #19.
 *
 * =============================================================================
 * WHAT THIS PAGE IS FOR, AND WHAT IT DELIBERATELY IS NOT
 * =============================================================================
 *
 * `VISION.md` describes one flow — **Capture → Correct → Transform → Use →
 * Find it again later** — and this page is its front door. Everything on it
 * answers one of six questions a person actually arrives with, in the order a
 * phone screen can afford them:
 *
 *   1. How do I capture something new?      → `HomeHero`
 *   2. How much of it is there, and where?  → `CountsStrip`
 *   3. What is happening right now?         → `InProgressSection`
 *   4. What went wrong?                     → `NeedsAttention`
 *   5. What was I working on?               → `RecentTranscripts`
 *   6. What did somebody send me?           → `SharedWithMe`
 *
 * The second and fourth are both epic #166's, and neither existed before it.
 *
 * Issue #368 adds a fourth-and-a-half, "Waiting for review" (`GraphReviewCard`),
 * directly under "Needs attention": connected-knowledge drafts nobody has
 * reviewed. It is a separate CONTENT TYPE behind a separate permission
 * (`graph:read`) and a deployment switch (`graphEnabled`), so it is the one
 * section with requests of its own — and it makes none at all unless the
 * caller holds `graph:read`.
 *
 * The second is issue #170 ("Home at Scale"), and it is the question this page
 * could not answer once an account had more than a screenful of anything: the
 * lists below are the newest few, and a user with four hundred transcripts had
 * no way to tell that from four. The strip answers it in four numbers built
 * from the summaries already fetched — no request of its own — each one a link
 * into the library it counts. See `CountsStrip`'s own header for why that is
 * not the stats dashboard rejected below.
 *
 * The fourth is issue #171: `counts.failed` had been on this page's summary
 * since #32 with nothing behind it, which is a number telling a user that
 * three of their recordings did not make it and giving them nowhere to go. See
 * `NeedsAttention`'s own header for why it sits between questions 3 and 5
 * rather than at the top.
 *
 * Since issue #107 several of those questions have a notes half: what is
 * generating right now joins the in-progress list, a note whose generation
 * failed joins the needs-attention list (#171), and "Recent notes" sits under
 * "Recent". That is the Transform stage of the vision arriving on the
 * page that describes it — until then this screen said "Coming soon" about a
 * feature the user could already reach from the navigation rail.
 *
 * Until issue #32 the page was the template's placeholder: a "Welcome back"
 * banner, a `UserProfileCard` restating the user's own email back at them, and
 * a `QuickActions` grid of links to Settings and the admin Console. Both
 * components are GONE, not merely unmounted — nothing else referenced either,
 * and profile and settings remain one tap away in the user menu and the
 * navigation rail/bottom bar, which is where a settings link belongs.
 *
 * A STATS DASHBOARD WAS CONSIDERED AND REJECTED (minutes transcribed, charts).
 * It helps a user neither capture nor find anything, which is the entire job of
 * this screen today; it becomes interesting once there is knowledge to
 * summarise, which is a later stage of the vision.
 *
 * =============================================================================
 * ONE CONTENT REQUEST PER CONTENT TYPE, ALL FIRED IN PARALLEL
 * =============================================================================
 *
 * THE RULE, and it is the one thing to keep straight when adding to this page:
 *
 *   **One request per CONTENT TYPE, all fired in parallel, none waiting on
 *   another — and no per-section list fetches.**
 *
 * Today that is two: `GET /api/transcripts/summary` (via
 * `useTranscriptSummary`) and `GET /api/notes/summary` (via `useNoteSummary`).
 * Each exists so that a phone on a cellular link makes ONE round trip for a
 * whole content type — three lists and four counts each — rather than one per
 * section racing the others and rendering in whatever order they land. So
 * "Recent notes" must never grow its own `GET /api/notes?limit=8`, and
 * "Shared with me" must never grow its own `?scope=shared`: a question one of
 * these endpoints could answer is answered by extending that endpoint.
 *
 * ⚠ AN AGGREGATE `GET /api/home/summary` WAS CONSIDERED AND REJECTED, and the
 * reason is authorisation rather than plumbing. The two summaries are gated on
 * two DIFFERENT permissions — `transcripts:read` and `notes:read` — and while
 * both are seeded to all three roles, neither implies the other and a
 * deployment is free to withhold either. One endpoint spanning both would have
 * to answer PARTIALLY for a user holding one of them: a 200 carrying half the
 * body, with some new per-section "you may not see this" marker invented for a
 * single page, or a 403 that hides the half they are entitled to. That is a new
 * authorisation shape in the API, owned by a page, and this codebase already
 * has one permission string per controller for a reason.
 *
 * The second reason is cadence. Each hook polls only while ITS OWN list has
 * something in flight (see either hook's header), so a transcript transcoding
 * polls every five seconds while the settled notes list costs nothing at all. A
 * merged endpoint has one poll interval and would necessarily run at whichever
 * cadence is faster, re-reading the quiet half of the page forever — on the
 * landing screen, which is the tab most likely to be left open overnight.
 *
 * NEITHER WAITS ON THE OTHER. The two hooks mount together and settle
 * independently; the page's full-page skeleton is gated on the TRANSCRIPT
 * summary alone and `RecentNotes` carries its own. Gating the whole screen on
 * both would make the page as slow as its slowest part for no benefit, which is
 * the same argument the capability probe below makes for itself.
 *
 * `GET /api/transcription/config` is the one call that is NOT content, and it
 * is a different kind of thing: a deployment CAPABILITY probe, not this user's
 * data. It decides whether the New-transcript button works at all, it is the
 * same probe `NewTranscriptPage` runs, and it cannot be folded into a summary
 * without making a per-user content endpoint also report deployment
 * configuration. It too is fired in parallel and never blocks the content.
 *
 * A FAILED PROBE IS TREATED AS "NOT AVAILABLE", copied deliberately from
 * `NewTranscriptPage`: an enabled button whose flow ends in a 409 is worse than
 * a disabled one that says why.
 *
 * =============================================================================
 * NO BREAKPOINT GATE LIVES HERE
 * =============================================================================
 *
 * There is not one `useMediaQuery` on this page or in any of the components it
 * mounts — `NoteSummaryCard` and `RecentNotes` (#107) and `CountsStrip` (#170)
 * included, which is why
 * neither may reach for one no matter how convenient a `<Stack>`/`<Grid>`
 * branch looks. Every responsive decision is a `sx`/`Grid` breakpoint object resolved
 * in CSS, so the five coupled gates listed in `docs/specs/settings-ui.md` §5
 * (and in CLAUDE.md's Settings UI Pattern rule 5) remain exactly five. The
 * page renders inside the shell's `<main>`, which already carries the
 * `pb: { xs: 10, sm: 3 }` that clears the fixed bottom bar — so nothing here
 * needs to know the bottom bar exists.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import { useEffect, useState } from 'react';

import { CountsStrip } from '../components/home/CountsStrip';
import { GraphReviewCard } from '../components/home/GraphReviewCard';
import { HomeHero } from '../components/home/HomeHero';
import { HomeSkeleton } from '../components/home/HomeSkeleton';
import { InProgressSection } from '../components/home/InProgressSection';
import { JourneyEmptyState } from '../components/home/JourneyEmptyState';
import { KnowledgeSection } from '../components/home/KnowledgeSection';
import { NeedsAttention } from '../components/home/NeedsAttention';
import { RecentNotes } from '../components/home/RecentNotes';
import { RecentTranscripts } from '../components/home/RecentTranscripts';
import { SharedWithMe } from '../components/home/SharedWithMe';
import { useAuth } from '../contexts/AuthContext';
import { useIsMounted } from '../hooks/useIsMounted';
import { useNoteSummary } from '../hooks/useNotes';
import { usePermissions } from '../hooks/usePermissions';
import { useTranscriptSummary } from '../hooks/useTranscripts';
import { getTranscriptionConfig } from '../services/transcription';

export default function HomePage() {
  const { user } = useAuth();
  const isMounted = useIsMounted();
  const { hasPermission } = usePermissions();
  const { summary, isLoading, error, refresh } = useTranscriptSummary();

  // THE PERMISSION GATE IS A HOOK ARGUMENT, NOT A CONDITIONAL MOUNT. A hook
  // cannot be called conditionally, and `enabled: false` issues no request at
  // all — so a user without `notes:read` costs this page a guaranteed 403
  // rather than saving one.
  const canReadNotes = hasPermission('notes:read');
  // Read ONCE and handed to both consumers — the hero's New-note action (#173)
  // and `RecentNotes`' zero-state button. Two `usePermissions()` reads, one per
  // component, would be two places for the same screen to disagree about the
  // same user; and `notes:write` is the exact string `notes.controller.ts`
  // enforces on `POST /api/notes`, which is also what `App.tsx` guards
  // `/notes/new` with.
  const canWriteNotes = hasPermission('notes:write');
  // The exact string `transcripts.controller.ts` enforces on `POST
  // /api/transcripts/:id/retry`, read here beside the notes pair rather than
  // inside `NeedsAttention` for the reason stated just above: one read, one
  // place for this screen to be right or wrong about this user.
  const canWriteTranscripts = hasPermission('transcripts:write');
  const notes = useNoteSummary({ enabled: canReadNotes });

  const [transcriptionAvailable, setTranscriptionAvailable] = useState(false);
  const [isCheckingTranscription, setIsCheckingTranscription] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void getTranscriptionConfig()
      .then((config) => {
        if (!cancelled && isMounted()) setTranscriptionAvailable(config.available);
      })
      .catch(() => {
        // See the header: a probe that failed is not a licence to offer the
        // flow. `NewTranscriptPage` makes exactly the same call.
        if (!cancelled && isMounted()) setTranscriptionAvailable(false);
      })
      .finally(() => {
        if (!cancelled && isMounted()) setIsCheckingTranscription(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isMounted]);

  // THE FIRST READ ONLY, AND ONLY THE TRANSCRIPT ONE. A poll never raises
  // `isLoading` (see the hook), so the skeleton appears once on arrival and the
  // content is never replaced by it — and the notes summary deliberately does
  // NOT gate this, because the two requests are parallel and holding the whole
  // landing screen blank for the slower of them would be the page waiting on
  // itself. `RecentNotes` renders its own skeleton meanwhile.
  if (isLoading) {
    return (
      <Container maxWidth="lg" disableGutters>
        <Box sx={{ py: { xs: 2, sm: 3 } }}>
          <HomeSkeleton />
        </Box>
      </Container>
    );
  }

  const inProgress = summary?.inProgress ?? [];
  const recent = summary?.recent ?? [];
  const sharedWithMe = summary?.sharedWithMe ?? [];
  const failed = summary?.failed ?? [];

  /**
   * Nothing of their own AND nothing shared AND nothing in flight.
   *
   * All three, not just `recent.length === 0`: a user whose first upload is
   * still transcoding has no recent transcripts yet, and showing them the
   * first-run walkthrough while their recording is visibly processing three
   * inches below it would be the page contradicting itself. `counts.owned`
   * is consulted too, so an account that owns transcripts none of which
   * landed in the newest eight (not a state the API produces today, but not
   * one this page should assume away) never sees the empty state either.
   *
   * ⚠ `summary !== null` IS THE LOAD-BEARING CLAUSE. Without it, a summary
   * request that FAILED — where every list is empty because nothing was ever
   * read, not because nothing exists — renders "You have no transcripts yet"
   * over the top of the error alert, which is the page confidently telling a
   * user with a hundred recordings that they have none.
   */
  const isNewUser =
    summary !== null &&
    recent.length === 0 &&
    sharedWithMe.length === 0 &&
    inProgress.length === 0 &&
    (summary?.counts.owned ?? 0) === 0 &&
    // AND NO NOTES (#107). A user can reach a note without ever recording
    // anything — generated from a document, or from a note somebody walked them
    // through creating — and showing that account "You have no transcripts yet.
    // Here is what happens once you do" over the top of the twelve notes they
    // wrote last week is the page telling them their work does not count.
    // `notes.summary` being null (no permission, or a failed read) contributes
    // `0`, which leaves the transcript clauses in charge — the honest default,
    // since the journey screen is about transcripts.
    (notes.summary?.counts.total ?? 0) === 0;

  return (
    <Container maxWidth="lg" disableGutters>
      <Box sx={{ py: { xs: 2, sm: 3 } }}>
        <HomeHero
          displayName={user?.displayName ?? null}
          transcriptionAvailable={transcriptionAvailable}
          isCheckingTranscription={isCheckingTranscription}
          canCreateNote={canWriteNotes}
        />

        {/* A stale page, not a blank one: the summary that is already on screen
            stays, and this says so. `useTranscriptSummary` deliberately keeps
            the last good answer through a failed refresh. */}
        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {/* Its own alert, under the transcript one, rather than a merged
            sentence: the two requests fail independently and "we could not load
            your notes" is actionable in a way "something went wrong" is not. */}
        {notes.error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {notes.error}
          </Alert>
        )}

        {/* THE COUNTS STRIP (#170, epic #166) — four numbers and nothing else,
            built from the two summaries already in hand. It issues NO request
            of its own; see its header, and see the call-count assertions in
            `HomePage.test.tsx`, which are what actually holds that.

            ⚠ `!isNewUser` IS THE GATE, deliberately at the call site rather
            than inside the component, because `isNewUser` is a fact about this
            whole page. A first-run account's strip would read 0 · 0 · 0 above
            the walkthrough explaining how to stop it reading zero.

            A failed summary read still renders nothing: the component returns
            null on a null `counts`, the same load-bearing reasoning
            `isNewUser` applies a few lines above. */}
        {!isNewUser && (
          <CountsStrip
            transcripts={summary?.counts ?? null}
            notes={notes.summary?.counts ?? null}
          />
        )}

        <InProgressSection items={inProgress} notes={notes.summary?.inProgress ?? []} />

        {isNewUser ? (
          <JourneyEmptyState
            transcriptionAvailable={transcriptionAvailable}
            isCheckingTranscription={isCheckingTranscription}
          />
        ) : (
          <>
            {/* ⚠ UNDER `InProgressSection`, ABOVE `RecentTranscripts`, and the
                position between those two is the decision (#171).

                "What is happening right now?" and "what went wrong two hours
                ago?" are different questions, and the first one wins the top
                of the page because its rows are the ones that STOP BEING
                ACTIONABLE. A live upload's pause and cancel controls exist
                only in this tab and only while the bytes are moving; a
                transcript that failed at lunchtime will still be failed, and
                still retryable, tomorrow. Putting a list of settled failures
                above a running upload would also mean the section a user sees
                immediately after pressing "New transcript" is the one about
                older work that did not happen.

                It sits ABOVE "Recent" for the mirror-image reason: a failed
                recording is not "recent work you might like to revisit", it is
                work that never happened, and burying it under the grid of
                everything that went fine is how a count nobody acts on became
                a count nobody acts on in the first place.

                INSIDE the non-`isNewUser` branch, so the first-run walkthrough
                is never accompanied by a list of failures. That is belt and
                braces rather than a reachable state — `isNewUser` requires
                `recent` to be empty, and a failed transcript is in `recent`
                too — but structure is a better guarantee than arithmetic. */}
            <NeedsAttention
              transcripts={failed}
              transcriptTotal={summary?.counts.failed ?? 0}
              // `[]` without `notes:read`: there is no notes summary for that
              // user to have failures in, and the hook is disabled entirely.
              notes={notes.summary?.failed ?? []}
              noteTotal={notes.summary?.counts.failed ?? 0}
              canRetryTranscripts={canWriteTranscripts}
              canRetryNotes={canWriteNotes}
              // Two refreshes, never one — see the component's header. A
              // retried transcript leaves the transcript summary's `failed`
              // list; nothing about the notes summary changed.
              onTranscriptRetried={() => void refresh()}
              onNoteRetried={() => void notes.refresh()}
            />
            {/* #368 — graph drafts waiting for review. Mounted only for
                `graph:read`; renders nothing unless the graph is on and a
                draft exists. */}
            {hasPermission('graph:read') && <GraphReviewCard />}
            <RecentTranscripts items={recent} />
            {/* ⚠ `notes.summary !== null || notes.isLoading` IS THE LOAD-BEARING
                CLAUSE, and it is the same one `isNewUser` needs above. A notes
                read that FAILED leaves every list empty because nothing was
                ever read, not because nothing exists — and `RecentNotes` would
                then invite a user with forty notes to make their first one,
                directly under the alert saying the read failed. A user without
                `notes:read` never renders the section at all. */}
            {canReadNotes && (notes.summary !== null || notes.isLoading) && (
              <RecentNotes
                items={notes.summary?.recent ?? []}
                total={notes.summary?.counts.total ?? 0}
                canCreate={canWriteNotes}
                isLoading={notes.isLoading}
              />
            )}
            {/* Knowledge (#373, spec §13) — the graph's entry point, since it
                has no bottom-bar tab. Renders nothing without `graph:read` or
                an entity to show, and never an error box. */}
            <KnowledgeSection />
            <SharedWithMe items={sharedWithMe} />
          </>
        )}
      </Box>
    </Container>
  );
}

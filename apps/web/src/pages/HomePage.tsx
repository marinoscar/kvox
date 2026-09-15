/**
 * `/` — the signed-in home page. Issue #32, epic #19.
 *
 * =============================================================================
 * WHAT THIS PAGE IS FOR, AND WHAT IT DELIBERATELY IS NOT
 * =============================================================================
 *
 * `VISION.md` describes one flow — **Capture → Correct → Transform → Use →
 * Find it again later** — and this page is its front door. Everything on it
 * answers one of four questions a person actually arrives with, in the order a
 * phone screen can afford them:
 *
 *   1. How do I capture something new?      → `HomeHero`
 *   2. What is happening right now?         → `InProgressSection`
 *   3. What was I working on?               → `RecentTranscripts`
 *   4. What did somebody send me?           → `SharedWithMe`
 *
 * Since issue #107 the third and fourth questions each have a notes half: what
 * is generating right now joins the in-progress list, and "Recent notes" sits
 * under "Recent". That is the Transform stage of the vision arriving on the
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
 * mounts — `NoteSummaryCard` and `RecentNotes` (#107) included, which is why
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

import { HomeHero } from '../components/home/HomeHero';
import { HomeSkeleton } from '../components/home/HomeSkeleton';
import { InProgressSection } from '../components/home/InProgressSection';
import { JourneyEmptyState } from '../components/home/JourneyEmptyState';
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
  const { summary, isLoading, error } = useTranscriptSummary();

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

        <InProgressSection items={inProgress} notes={notes.summary?.inProgress ?? []} />

        {isNewUser ? (
          <JourneyEmptyState
            transcriptionAvailable={transcriptionAvailable}
            isCheckingTranscription={isCheckingTranscription}
          />
        ) : (
          <>
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
            <SharedWithMe items={sharedWithMe} />
          </>
        )}
      </Box>
    </Container>
  );
}

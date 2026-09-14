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
 * Until this issue the page was the template's placeholder: a "Welcome back"
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
 * ONE DATA REQUEST, PLUS ONE CAPABILITY PROBE — AND WHY THAT IS NOT TWO
 * =============================================================================
 *
 * All the page's CONTENT comes from a single `GET /api/transcripts/summary`
 * (via `useTranscriptSummary`), so a phone on a cellular link makes one round
 * trip for three lists and four counts rather than four requests racing each
 * other. That is what the endpoint exists for; do not add a second content
 * fetch here.
 *
 * `GET /api/transcription/config` is the one other call, and it is a different
 * kind of thing: a deployment CAPABILITY probe, not this user's data. It
 * decides whether the New-transcript button works at all, it is the same probe
 * `NewTranscriptPage` runs, and it cannot be folded into the summary without
 * making a per-user content endpoint also report deployment configuration. It
 * is fired in parallel and never blocks the content — a page that waited for
 * both would be as slow as the slower one for no benefit.
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
 * mounts. Every responsive decision is a `sx`/`Grid` breakpoint object resolved
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
import { RecentTranscripts } from '../components/home/RecentTranscripts';
import { SharedWithMe } from '../components/home/SharedWithMe';
import { useAuth } from '../contexts/AuthContext';
import { useIsMounted } from '../hooks/useIsMounted';
import { useTranscriptSummary } from '../hooks/useTranscripts';
import { getTranscriptionConfig } from '../services/transcription';

export default function HomePage() {
  const { user } = useAuth();
  const isMounted = useIsMounted();
  const { summary, isLoading, error } = useTranscriptSummary();

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

  // THE FIRST READ ONLY. A poll never raises `isLoading` (see the hook), so the
  // skeleton appears once on arrival and the content is never replaced by it.
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
   */
  const isNewUser =
    recent.length === 0 &&
    sharedWithMe.length === 0 &&
    inProgress.length === 0 &&
    (summary?.counts.owned ?? 0) === 0;

  return (
    <Container maxWidth="lg" disableGutters>
      <Box sx={{ py: { xs: 2, sm: 3 } }}>
        <HomeHero
          displayName={user?.displayName ?? null}
          transcriptionAvailable={transcriptionAvailable}
          isCheckingTranscription={isCheckingTranscription}
        />

        {/* A stale page, not a blank one: the summary that is already on screen
            stays, and this says so. `useTranscriptSummary` deliberately keeps
            the last good answer through a failed refresh. */}
        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        <InProgressSection items={inProgress} />

        {isNewUser ? (
          <JourneyEmptyState
            transcriptionAvailable={transcriptionAvailable}
            isCheckingTranscription={isCheckingTranscription}
          />
        ) : (
          <>
            <RecentTranscripts items={recent} />
            <SharedWithMe items={sharedWithMe} />
          </>
        )}
      </Box>
    </Container>
  );
}

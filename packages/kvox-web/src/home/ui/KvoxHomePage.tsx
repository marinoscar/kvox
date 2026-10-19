/**
 * The signed-in Home page, packaged. Issue #32 (epic #19) built it for KVox web;
 * issue #632 (epic marinoscar/kvox-desktop#26) moved it here so every host shows the
 * same first-run experience.
 *
 * =============================================================================
 * WHAT THIS PAGE IS FOR, AND WHAT IT DELIBERATELY IS NOT
 * =============================================================================
 *
 * `VISION.md` describes one flow — **Capture → Correct → Transform → Use → Find it
 * again later** — and this page is its front door. Everything on it answers one of
 * the questions a person actually arrives with, in the order a phone screen can
 * afford them:
 *
 *   1. How do I capture something new?      → `HomeHero`
 *   2. How much of it is there, and where?  → `CountsStrip`
 *   3. What is happening right now?         → `InProgressSection`
 *   4. What went wrong?                     → `NeedsAttention`
 *   5. What am I waiting to review?         → `GraphReviewCard`
 *   6. What was I working on?               → `RecentTranscripts`, `RecentNotes`
 *   7. Who and what do my notes mention?    → `KnowledgeSection`
 *   8. What did somebody send me?           → `SharedWithMe`
 *
 * An account with nothing yet sees `JourneyEmptyState` instead of everything under
 * the counts: a product explanation in place of a shrug.
 *
 * A STATS DASHBOARD WAS CONSIDERED AND REJECTED (minutes transcribed, charts). It
 * helps a person neither capture nor find anything, which is the entire job of this
 * screen today.
 *
 * =============================================================================
 * IT READS THE HOST AND NOTHING ELSE
 * =============================================================================
 *
 * The page reads {@link useKvoxHost} and the slice hooks, never an auth context, an
 * API client or a router helper of the app that mounts it. Who the viewer is, what
 * they may do and whether connected knowledge is on come from `KvoxWebHost.viewer()`
 * and `features()`; every request goes through `KvoxWebHost.http`. That is what lets
 * KVox web and KVox Desktop render the SAME page.
 *
 * What differs between hosts is a SLOT, not a fork:
 *
 *   - `heroActions`: the host's own buttons in the hero (KVox web: "New transcript").
 *   - `extraSteps`: the host's own journey steps ("Record or upload audio" on web,
 *     "Import a document" on Desktop). `journeySteps` replaces the slices' own.
 *   - `sections`: which blocks exist at all (Desktop has no transcription in v1).
 *
 * =============================================================================
 * ONE CONTENT REQUEST PER CONTENT TYPE, ALL FIRED IN PARALLEL
 * =============================================================================
 *
 * THE RULE, and it is the one thing to keep straight when adding to this page:
 *
 *   **One request per CONTENT TYPE, all fired in parallel, none waiting on another —
 *   and no per-section list fetches.**
 *
 * Today that is two: `GET /api/transcripts/summary` (`useTranscriptSummary`) and
 * `GET /api/notes/summary` (`useNoteSummary`). Each exists so that a phone on a
 * cellular link makes ONE round trip for a whole content type — three lists and four
 * counts each — rather than one per section racing the others. So "Recent notes"
 * must never grow its own `GET /api/notes?limit=8`, and "Shared with me" must never
 * grow its own `?scope=shared`: a question one of these endpoints could answer is
 * answered by extending that endpoint.
 *
 * ⚠ AN AGGREGATE `GET /api/home/summary` WAS CONSIDERED AND REJECTED, and the reason
 * is authorisation rather than plumbing. The two summaries are gated on two DIFFERENT
 * permissions — `transcripts:read` and `notes:read` — and neither implies the other.
 * One endpoint spanning both would have to answer PARTIALLY for a user holding one of
 * them, which is a new authorisation shape owned by a page. The second reason is
 * cadence: each hook polls only while ITS OWN list has something in flight, and a
 * merged endpoint would re-read the quiet half of the page forever, on the landing
 * screen, which is the tab most likely to be left open overnight.
 *
 * NEITHER WAITS ON THE OTHER. The two hooks mount together and settle independently;
 * the full-page skeleton is gated on the transcript summary alone (on the notes
 * summary when the host has no transcripts) and `RecentNotes` carries its own.
 *
 * =============================================================================
 * NO BREAKPOINT GATE LIVES HERE
 * =============================================================================
 *
 * There is not one `useMediaQuery` on this page or in any of the components it
 * mounts. Every responsive decision is a `sx`/`Grid` breakpoint object resolved in
 * CSS, so the five coupled gates of `docs/specs/settings-ui.md` §5 remain exactly
 * five. The page renders inside the shell's `<main>`, which already carries the
 * `pb: { xs: 10, sm: 3 }` that clears the fixed bottom bar.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import type { ReactNode } from 'react';

import { useKvoxHost, useKvoxPermissionCheck } from '../../core/headless/index.js';
import { useNoteSummary } from '../../notes/headless/index.js';
import { useTranscriptSummary } from '../../transcripts/headless/index.js';
import {
  KVOX_HOME_SECTIONS,
  isNewAccount,
  resolveJourneySteps,
} from '../headless/index.js';
import type { KvoxHomeSection, KvoxJourneyStep } from '../headless/index.js';
import { CountsStrip } from './components/CountsStrip.js';
import { GraphReviewCard } from './components/GraphReviewCard.js';
import { HomeHero } from './components/HomeHero.js';
import { HomeSkeleton } from './components/HomeSkeleton.js';
import { InProgressSection } from './components/InProgressSection.js';
import { JourneyEmptyState } from './components/JourneyEmptyState.js';
import type { JourneyStage } from './components/JourneyEmptyState.js';
import { KnowledgeSection } from './components/KnowledgeSection.js';
import { NeedsAttention } from './components/NeedsAttention.js';
import { RecentNotes } from './components/RecentNotes.js';
import { RecentTranscripts } from './components/RecentTranscripts.js';
import { SharedWithMe } from './components/SharedWithMe.js';

/**
 * Props of {@link KvoxHomePage}. Every one is optional: `<KvoxHomePage />` is the
 * Home a host with a bare binding gets.
 *
 * @stability experimental
 */
export interface KvoxHomePageProps {
  /**
   * Replaces the journey steps the slices ship (write a note, explore the
   * knowledge). Default: the slices' own, filtered by the viewer's permissions and
   * the deployment's `graph` switch. Pass `[]` for none.
   */
  journeySteps?: readonly KvoxJourneyStep[];
  /**
   * The host's own journey steps, drawn after the others in the order given and
   * filtered the same way (KVox web: "Record or upload audio"; Desktop: "Import a
   * document").
   */
  extraSteps?: readonly KvoxJourneyStep[];
  /** The host's own actions in the hero, drawn before the packaged "New note". */
  heroActions?: ReactNode;
  /**
   * The sections to draw; the page keeps its own order. Default every section
   * ({@link KVOX_HOME_SECTIONS}). Leaving out `recentTranscripts` is how a host
   * without transcripts avoids the transcript summary request altogether.
   */
  sections?: readonly KvoxHomeSection[];
  /**
   * The one-line promise under the greeting: the host's identity (KVox web passes
   * `TAGLINE` of `@app/shared`; a host on the brand entry passes
   * `KVOX_BRAND.tagline`). Not drawn when absent.
   */
  tagline?: string;
  /** Replaces the four stage cards of the first-run journey. */
  journeyStages?: readonly JourneyStage[];
  /** Replaces the sentence under "Start here". */
  journeyIntro?: string;
}

/**
 * The signed-in Home page: greeting and actions, the counts, what is moving, what
 * failed, what is waiting for review, the recent transcripts and notes, the
 * knowledge, what others shared with you, and the first-run journey for an account
 * with nothing yet.
 *
 * @remarks
 * Needs a `KvoxWebHostProvider` above it and a router, and, unless `recentTranscripts`
 * is left out of `sections`, the `KvoxUploadManagerProvider` of the transcripts slice
 * (the in-progress block lists this tab's uploads). Everything host-specific is a
 * prop: see {@link KvoxHomePageProps}. The page lays out inside the host's shell and
 * brings no frame of its own beyond a `Container`.
 *
 * @param props - see {@link KvoxHomePageProps}.
 * @returns the page.
 *
 * @example
 * ```tsx
 * // A host without transcription (KVox Desktop in v1).
 * <KvoxHomePage
 *   sections={['hero', 'journey', 'recentNotes', 'knowledge']}
 *   extraSteps={[importStep]}
 *   tagline={KVOX_BRAND.tagline}
 * />
 * ```
 *
 * @stability experimental
 */
export function KvoxHomePage(props: KvoxHomePageProps = {}) {
  const {
    journeySteps,
    extraSteps,
    heroActions,
    sections = KVOX_HOME_SECTIONS,
    tagline,
    journeyStages,
    journeyIntro,
  } = props;

  const host = useKvoxHost();
  const hasPermission = useKvoxPermissionCheck();
  const shown = new Set<KvoxHomeSection>(sections);

  // The transcript half of the page exists only when the host lists it: a host
  // with no transcription never asks an API that is not there.
  const transcriptsOn = shown.has('recentTranscripts');
  const transcripts = useTranscriptSummary({ enabled: transcriptsOn });
  const { summary, error, refresh } = transcripts;

  const canReadNotes = hasPermission('notes:read');
  const canWriteNotes = hasPermission('notes:write');
  const canWriteTranscripts = hasPermission('transcripts:write');
  const notes = useNoteSummary({ enabled: canReadNotes });

  // The skeleton waits on the first answer of the page's leading content type.
  const isLoading = transcriptsOn ? transcripts.isLoading : notes.isLoading;
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

  // ⚠ "NEW" IS A FACT ABOUT THE WHOLE PAGE. A transcript summary that has not been
  // read (or failed) is not a new account: nothing was read, so nothing is known to
  // be missing. A host with no transcripts has nothing to wait for on that side.
  const isNewUser = isNewAccount({
    transcriptsSettled: !transcriptsOn || summary !== null,
    ownedTranscripts: summary?.counts.owned ?? 0,
    recentTranscripts: recent.length,
    sharedTranscripts: sharedWithMe.length,
    inProgress: inProgress.length,
    notes: notes.summary?.counts.total ?? 0,
  });
  const showJourney = isNewUser && shown.has('journey');

  const steps = resolveJourneySteps({
    ...(journeySteps === undefined ? {} : { journeySteps }),
    ...(extraSteps === undefined ? {} : { extraSteps }),
    progress: { notes: notes.summary?.counts.total ?? 0 },
    context: { hasPermission, graphEnabled: host.features().graphEnabled === true },
  });

  return (
    <Container maxWidth="lg" disableGutters>
      <Box sx={{ py: { xs: 2, sm: 3 } }}>
        {shown.has('hero') && (
          <HomeHero
            displayName={host.viewer()?.displayName ?? null}
            {...(tagline === undefined ? {} : { tagline })}
            actions={heroActions}
            canCreateNote={canWriteNotes}
          />
        )}

        {/* A stale page, not a blank one: the summary that is already on screen
            stays, and this says so. `useTranscriptSummary` deliberately keeps the
            last good answer through a failed refresh. */}
        {transcriptsOn && error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {/* Its own alert, under the transcript one, rather than a merged sentence:
            the two requests fail independently and "we could not load your notes"
            is actionable in a way "something went wrong" is not. */}
        {notes.error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {notes.error}
          </Alert>
        )}

        {/* THE COUNTS STRIP (#170) — four numbers and nothing else, built from the
            two summaries already in hand. It issues NO request of its own.

            ⚠ `!showJourney` IS THE GATE, deliberately at the call site, because
            "new" is a fact about this whole page: a first-run account's strip would
            read 0 · 0 · 0 above the walkthrough explaining how to stop it reading
            zero. A failed summary read still renders nothing: the component returns
            null on a null `counts`. */}
        {!showJourney && shown.has('counts') && (
          <CountsStrip
            transcripts={summary?.counts ?? null}
            notes={notes.summary?.counts ?? null}
          />
        )}

        {shown.has('inProgress') && (
          <InProgressSection
            items={inProgress}
            notes={notes.summary?.inProgress ?? []}
            uploads={transcriptsOn}
          />
        )}

        {showJourney ? (
          <JourneyEmptyState
            steps={steps}
            {...(journeyStages === undefined ? {} : { stages: journeyStages })}
            {...(journeyIntro === undefined ? {} : { intro: journeyIntro })}
          />
        ) : (
          <>
            {/* ⚠ UNDER `InProgressSection`, ABOVE `RecentTranscripts`, and the
                position between those two is the decision (#171): what is happening
                right now wins the top of the page because its rows are the ones that
                STOP BEING ACTIONABLE (a live upload's pause and cancel exist only
                while the bytes move); a failed transcript is still failed and still
                retryable tomorrow. It sits ABOVE "Recent" because a failed recording
                is not "recent work you might like to revisit", it is work that never
                happened. INSIDE the non-new branch, so the first-run walkthrough is
                never accompanied by a list of failures. */}
            {shown.has('needsAttention') && (
              <NeedsAttention
                transcripts={failed}
                transcriptTotal={summary?.counts.failed ?? 0}
                notes={notes.summary?.failed ?? []}
                noteTotal={notes.summary?.counts.failed ?? 0}
                canRetryTranscripts={canWriteTranscripts}
                canRetryNotes={canWriteNotes}
                onTranscriptRetried={() => void refresh()}
                onNoteRetried={() => void notes.refresh()}
              />
            )}
            {/* #368 — graph drafts waiting for review. Mounted only for `graph:read`;
                renders nothing unless the graph is on and a draft exists. */}
            {shown.has('knowledge') && hasPermission('graph:read') && <GraphReviewCard />}
            {transcriptsOn && <RecentTranscripts items={recent} />}
            {/* ⚠ `notes.summary !== null || notes.isLoading` IS THE LOAD-BEARING
                CLAUSE. A notes read that FAILED leaves every list empty because
                nothing was ever read, not because nothing exists — and
                `RecentNotes` would then invite a user with forty notes to make
                their first one, directly under the alert saying the read failed. A
                user without `notes:read` never renders the section at all. */}
            {shown.has('recentNotes') && canReadNotes && (notes.summary !== null || notes.isLoading) && (
              <RecentNotes
                items={notes.summary?.recent ?? []}
                total={notes.summary?.counts.total ?? 0}
                canCreate={canWriteNotes}
                isLoading={notes.isLoading}
              />
            )}
            {/* Knowledge (#373) — recent entities, a shortcut into the graph.
                Renders nothing without `graph:read` or an entity to show, and never
                an error box. */}
            {shown.has('knowledge') && <KnowledgeSection />}
            {shown.has('sharedWithMe') && <SharedWithMe items={sharedWithMe} />}
          </>
        )}
      </Box>
    </Container>
  );
}

import {
  type JobExecutionProfile,
  type JobHandler,
  JobHandlerRegistry,
} from '@marinoscar/platform-api/jobs';
// =============================================================================
// `user.data.purge` (issue #80) — the Danger Zone's one job
// =============================================================================
//
// Deletes, in bulk, the data ONE user owns, in the scope they confirmed. It is
// the most destructive thing an ordinary account can ask this application to do
// and the only thing in this repository that reaches across transcripts, notes,
// note templates, storage, personal access tokens and AI credentials in a
// single run.
//
// -----------------------------------------------------------------------------
// ⚠ IT DOES NOT DELETE THE ACCOUNT
// -----------------------------------------------------------------------------
//
// No scope touches the `users` row, `user_roles`, `refresh_tokens` or the
// caller's session. The user stays signed in and their account keeps working;
// what goes is DATA, KEYS and — under `everything` only — the one
// `user_settings` namespace named below. "Delete everything" here means "this
// deployment stops holding my content", not "close my account" — two different
// requests with two different consequences, and conflating them would mean a
// user clearing their library discovered they had also locked themselves out.
//
// ⚠ THE ONE `user_settings` NAMESPACE `everything` CLEARS IS `onboarding`.
// Nothing else in that row is touched by any scope: `theme`, `profile`,
// `navigation`, `notifications` and `dataTables` all survive every deletion.
// Deleting your data is not "reset my preferences" — the account still works
// and the user is still signed in looking at it, so coming back to a light
// theme they had switched away from would be an unasked-for change with no
// relationship to what they clicked.
//
// `onboarding` is different because it is not a PREFERENCE, it is a record
// that first-run guidance has already been given (epic #271, issue #272:
// `welcomeSeenAt`, `dismissedAt`, `adminDismissedAt`, `skipped[]`). A full
// wipe genuinely starts over, and the checklist — which is derived live, never
// stored — correctly regresses on its own: no transcripts and no AI key put
// its required steps back outstanding. But the SURVIVING intent then hides
// them, because `chooseBannerAudience` bails on `dismissedAt` and
// `FirstRunWelcomeDialog`'s `due` gate bails on `welcomeSeenAt`. A user who
// deleted everything and was then shown no first-run guidance at all would
// reasonably conclude the feature was broken, and their only way back is the
// replay button on a settings page they have no reason to open. See step 6.
//
// -----------------------------------------------------------------------------
// ⚠ SERVER-ONLY, PERMANENTLY — NO `nodeResultSchema`, NO `persistNodeResult`
// -----------------------------------------------------------------------------
//
// CLAUDE.md rule 2 makes node-eligibility the DEFAULT posture, so a type that
// opts out owes an argument. This one has two, and either alone is sufficient.
//
// It reads and writes across `transcripts`, `notes`, `note_templates`,
// `storage_objects` and `personal_access_tokens`
// MID-COMPUTATION — each batch's contents decide the next query, and clearing a
// foreign key is what makes the delete after it possible. There is no
// "already-computed result" a remote machine could post back; the work IS the
// sequence of writes.
//
// And it holds the authority to destroy a user's entire dataset. That is
// rule 2's "needs a privilege a remote machine must never hold", in its
// strongest form: the database restore is the canonical example because it
// replaces the live database, and this is the same shape pointed at one
// account. A `nodeSecretBroker` cannot help — there is no credential narrow
// enough to mean "may delete exactly this user's rows and nothing else", so
// brokering one would mean handing a worker node write access to five tables.
//
// -----------------------------------------------------------------------------
// ⚠ `profile: { maxAttempts: 1 }` — NEVER AUTOMATICALLY RETRIED
// -----------------------------------------------------------------------------
//
// The handler IS re-entrant (see below), so a second run would be safe in the
// narrow sense of not corrupting anything. It is still wrong to start one
// automatically. A destructive fan-out that failed part-way through has already
// deleted some of the user's data and not the rest, and the only honest thing
// to do with that is SHOW IT: a `failed` job, with `lastError` naming the step,
// that a person looks at. An auto-retry would quietly re-run the remaining
// destruction minutes later and, if it succeeded, leave no trace that anything
// had gone wrong with a deletion the user is entitled to know the outcome of.
//
// `POST /api/user-data/deletions` is the explicit retry path — a person
// pressing a button, queuing a fresh job with its own one-attempt budget. That
// is exactly the relationship `POST /api/notes/:id/regenerate` has with
// `note.generate` (`docs/specs/notes.md`, and CLAUDE.md's rule 2 for that
// module), for the same reason: the retry of an irreversible, user-visible
// action belongs to the user.
//
// `maxRuntimeMs` is left on the deployment default deliberately. This job's
// own work is batched database writes; the slow part — deleting bytes from
// object storage — happens in the per-item `transcript.purge`/`note.purge` jobs
// it fans out to, each with its own timeout and its own row in the job list.
//
// -----------------------------------------------------------------------------
// ⚠ FORCE SEMANTICS: THE PER-ITEM 409 GUARDS DO NOT APPLY HERE
// -----------------------------------------------------------------------------
//
// `NotesService.remove` refuses (409) while a note is `generating` or while
// another note is derived from it; `TranscriptsService.remove` refuses while a
// note cites the transcript. Both refusals are right for a single delete: they
// exist so one click does not silently break something the user did not have in
// view.
//
// A bulk deletion is the opposite situation. The user has been shown a
// per-category inventory and typed the scope's name; "delete my notes, except
// four of them, because of relationships between notes you were not shown" is
// not a result anyone asked for, and it is unfixable from the UI — the blocking
// note is itself in the set being deleted. So this handler honours neither
// guard.
//
// It does NOT force by catching foreign-key violations, and it does not disable
// any constraint. Every blocking column is `Restrict`, so it CLEARS THE
// REFERENCE FIRST and the delete that follows is then an ordinary one:
//
//   • `notes.source_note_id` — cleared on every note pointing at a note in the
//     batch, before that batch is soft-deleted.
//   • `notes.source_transcript_id` — cleared on every note pointing at a
//     transcript in the batch. ⚠ INCLUDING ANOTHER USER'S NOTE. A transcript
//     can be shared, and a note somebody else generated from it is THEIR
//     content: it keeps its full text and loses only the provenance link,
//     because the alternative is either refusing the owner's deletion or
//     deleting a stranger's note. Losing a pointer to a recording that is
//     about to stop existing is the smallest of the three losses, and it is
//     deliberate rather than incidental.
//
// -----------------------------------------------------------------------------
// IT REUSES THE PER-ITEM PURGE MACHINERY. IT DELETES NO BYTES ITSELF.
// -----------------------------------------------------------------------------
//
// Nothing here talks to object storage. A transcript is soft-deleted and handed
// to `transcript.purge`; a note to `note.purge`; an unmanaged upload goes
// through `ObjectsService.delete`. Those already know the five objects a
// transcript owns, the provider-side cancellation it may still need, and the
// order `Restrict` forces — and they are already exercised by every single-item
// delete in the application. A second implementation of byte deletion living
// here would be a second thing to keep correct, diverging silently the first
// time a new artifact is added to either module.
//
// The fan-out is batched exactly like `notes.housekeeping`'s
// `requeueStalledPurges`: take a page of ids, ONE `job.findMany` to learn which
// of them a live purge already covers, then enqueue for the rest. Never a
// per-row job lookup — that turns a sweep into an N+1 against the table the
// queue is itself contending on.
//
// -----------------------------------------------------------------------------
// ORDER, AND WHY IT IS NOT STYLISTIC
// -----------------------------------------------------------------------------
//
// THE STEPS ARE THE REGISTERED USER-DATA CATEGORIES (issue #460), run in the
// order each declares in `purge.order`. Today's order, which no registration may
// reshuffle, is:
//
//   1. ask conversations   (10; `content`/`everything` only)
//   2. knowledge graph     (20; `content`/`everything` only — enqueues `kg.purge`)
//   3. credentials         (30; `everything` only)
//   4. notes               (40) — clearing `source_note_id` first
//   5. transcripts         (50) — clearing `source_transcript_id` first
//   6. note templates      (60; `content`/`everything` only — never the narrow
//                           `notes` scope; see `scopeIncludes`)
//   7. unmanaged storage objects (70)
//   8. onboarding state    (80; `everything` only)
//
// Each step is a method on a hook class declared by the category's own module
// (`ask/ask.user-data.ts`, `graph/graph.user-data.ts`, `notes/notes.user-data.ts`,
// `transcripts/transcripts.user-data.ts`, `user-data/user-data.base.ts`); this
// handler resolves them with `ModuleRef` and imports no domain. Every hook the
// scope reaches is resolved BEFORE the first destructive step, and a hook that
// cannot be resolved fails the job — a category is never skipped silently.
//
// The chain that decides the order of 4 to 7, in the vocabulary the rest of
// this header (and the spec's §4) uses:
//
//   notes -> transcripts -> note templates -> unmanaged storage objects
//
// 4 before 5 because a note's `source_transcript_id` is `Restrict`: deleting
// transcripts while the user's own notes still cite them would leave the
// transcript purge blocked. 6 after 4 because `NoteTemplatesService.remove`
// archives rather than deletes while notes still reference a template, so the
// notes have to have gone first for a delete to be possible at all — and every
// scope that reaches step 6 has already run step 4, so that ordering is never
// vacuous. 7 last because it is the only step whose rows nothing else can point
// at.
//
// Credentials go FIRST rather than in that chain, and they are the one step
// that has a choice: they participate in no foreign key with anything above
// them (both tables cascade from `users` and from nothing else). Revoking a
// key is fast and definitive, and a user who asked for their keys to be gone
// should not have them still working while several minutes of fan-out runs.
//
// The onboarding reset goes LAST, and that is the other step with a genuine
// choice — it participates in no foreign key either, and it destroys no
// content, so nothing forces its position. It is last because of what it
// ASSERTS: showing a user their first-run checklist again says "you are
// starting over". Run first, a later step throwing would leave them looking at
// a fresh-start banner over a library that is still half there — guidance that
// contradicts the screen behind it. Run last, the reset is the closing act of a
// run that got all the way through, and a run that did not simply never makes
// the claim.
//
// -----------------------------------------------------------------------------
// RE-ENTRANCY: THE REMAINING WORK IS DISCOVERABLE FROM THE ROWS
// -----------------------------------------------------------------------------
//
// Every step asks the database what is left rather than carrying a cursor: live
// notes, live transcripts, owned templates, unmanaged objects — and the
// onboarding reset is idempotent by construction, since clearing an
// already-absent namespace stores the same absence. A second run
// after a partial first one finds exactly the remainder and finishes it, and a
// run with nothing to do succeeds having done nothing. Nothing here counts
// down, charges twice, or fails because something is already gone — which is
// what makes the deliberate absence of an automatic retry a policy choice
// rather than a limitation.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Job } from '@prisma/client';

import { USER_DATA_PURGE_JOB_TYPE, type UserDataScope } from '../job-types';
import {
  assertUserDataRegistriesConsistent,
  userDataPurgeSteps,
} from '../user-data.registries';
import {
  resolveUserDataHook,
  USER_DATA_PURGE_BATCH,
  USER_DATA_PURGE_MAX_BATCHES,
} from '../user-data.support';
import { readPurgePayload } from '../user-data.service';

// Re-exported so existing importers of the bounds keep their path; the
// definitions moved to `user-data.support.ts` so hook classes in other folders
// can share them.
export { USER_DATA_PURGE_BATCH, USER_DATA_PURGE_MAX_BATCHES };

@Injectable()
export class UserDataPurgeHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(UserDataPurgeHandler.name);

  readonly type = USER_DATA_PURGE_JOB_TYPE;

  readonly label = 'Account data deletion';

  /**
   * See the header for `maxAttempts: 1`, which is the decision this profile
   * exists to record.
   *
   * `maxRuntimeMs` has to be declared beside it — a profile is the pair or
   * nothing — so it is given a real ceiling rather than the `0` that means "no
   * ceiling at all". Thirty minutes is generously more than a library of tens
   * of thousands of rows needs, because this job's own work is batched database
   * writes and enqueues; the slow part, deleting bytes, happens in the
   * per-item `transcript.purge`/`note.purge` jobs it fans out to, each with its
   * own timeout and its own row in the job list. A run that somehow exceeds it
   * fails visibly with a partial deletion the user can see and re-request,
   * which is exactly what `maxAttempts: 1` is for — and is a better outcome
   * than an unbounded job holding a worker slot indefinitely.
   */
  readonly profile: JobExecutionProfile = {
    maxRuntimeMs: 30 * 60_000,
    maxAttempts: 1,
  };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    // A scope naming a category nothing registered would delete less than its
    // confirmation dialog promised and fail nowhere else, so refuse to boot.
    assertUserDataRegistriesConsistent();

    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const payload = readPurgePayload(job.payload);

    if (!payload) {
      // ⚠ RETURNS RATHER THAN THROWS, and the asymmetry is deliberate. A
      // payload this build cannot read names no user and no scope, so there is
      // nothing to delete and nothing a retry could learn. Throwing would mark
      // a destructive job `failed` and invite somebody to retry it, which is
      // the one reaction that must not be encouraged here.
      this.logger.warn(
        `Purge job ${job.id} carries no readable user-data payload; nothing to do`,
      );

      return;
    }

    const { userId, scope } = payload;

    this.logger.warn(
      `Starting bulk deletion of scope "${scope}" for user ${userId} (job ${job.id})`,
    );

    // ⚠ EVERY HOOK THE SCOPE REACHES IS RESOLVED BEFORE THE FIRST STEP RUNS. A
    // hook that cannot be found throws here — failing the job before anything
    // has been destroyed, never skipping its category and reporting success.
    const steps = userDataPurgeSteps(scope).map((category) => {
      const purge = category.purge as NonNullable<typeof category.purge>;

      return {
        category,
        purge,
        instance: resolveUserDataHook(this.moduleRef, purge.inject, category.id, 'purge'),
      };
    });

    // The steps run in `purge.order` — see the header's ORDER section. Last in
    // that order is the onboarding reset: this is the one step that makes a
    // CLAIM to the user ("you are starting over") rather than destroying
    // something, so it may only run after the destruction it narrates has
    // actually been carried out.
    for (const { purge, instance } of steps) {
      await purge.run(instance, userId, { jobId: job.id, scope });
    }

    this.logger.warn(
      `Bulk deletion of scope "${scope}" for user ${userId} has been queued out ` +
        `(job ${job.id})`,
    );
  }
}

/** Re-exported so a reader of this file does not have to chase the union. */
export type { UserDataScope };

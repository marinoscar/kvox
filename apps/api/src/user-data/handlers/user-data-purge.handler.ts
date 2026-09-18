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
// `storage_objects`, `personal_access_tokens` and `user_ai_credentials`
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
// brokering one would mean handing a worker node write access to six tables.
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
//   1. credentials      (`everything` only)
//   2. notes            — clearing `source_note_id` first
//   3. transcripts      — clearing `source_transcript_id` first
//   4. note templates   (`content`/`everything` only — never the narrow `notes`
//                        scope; see `scopeIncludes`)
//   5. unmanaged storage objects
//   6. onboarding state (`everything` only)
//
// 2 before 3 because a note's `source_transcript_id` is `Restrict`: deleting
// transcripts while the user's own notes still cite them would leave the
// transcript purge blocked. 4 after 2 because `NoteTemplatesService.remove`
// archives rather than deletes while notes still reference a template, so the
// notes have to have gone first for a delete to be possible at all — and every
// scope that reaches step 4 has already run step 2, so that ordering is never
// vacuous. 5 last
// because it is the only step whose rows nothing else can point at.
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
import type { Job, Prisma } from '@prisma/client';

import { UserAiCredentialsService } from '../../ai/user-ai-credentials.service';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { NOTE_PURGE_JOB_TYPE, NOTE_SUBJECT_TYPE } from '../../notes/job-types';
import { NoteTemplatesService } from '../../notes/note-templates.service';
import { NotesService } from '../../notes/notes.service';
import { PatService } from '../../pat/pat.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SEARCH_DOC_NOTE, SEARCH_DOC_TRANSCRIPT } from '../../search/indexing/job-types';
import { SearchIndexService } from '../../search/indexing/search-index.service';
import { UserSettingsService } from '../../settings/user-settings/user-settings.service';
import { ObjectsService } from '../../storage/objects/objects.service';
import {
  TRANSCRIPT_PURGE_JOB_TYPE,
  TRANSCRIPT_SUBJECT_TYPE,
} from '../../transcripts/job-types';
import { TranscriptPipelineService } from '../../transcripts/transcript-pipeline.service';
import {
  scopeIncludes,
  USER_DATA_PURGE_JOB_TYPE,
  type UserDataScope,
} from '../job-types';
import { readPurgePayload } from '../user-data.service';

/**
 * Rows per batch, matching `NOTES_HOUSEKEEPING_BATCH`.
 *
 * The number is a compromise between round trips and the size of the `IN` list
 * the job lookup builds; 200 is what the notes sweep already settled on and
 * there is no reason for this file to pick a different one.
 */
export const USER_DATA_PURGE_BATCH = 200;

/**
 * Most batches any one step will run before giving up.
 *
 * A STOP, NOT A BUDGET. Every loop below terminates by its own predicate
 * (a soft-deleted note no longer matches `deletedAt: null`), so reaching this
 * bound means a row is being selected and not changed — a state where looping
 * forever would hold a worker slot and produce nothing. Hitting it throws, so
 * the job fails loudly with the step named instead of running until the
 * timeout.
 */
export const USER_DATA_PURGE_MAX_BATCHES = 5_000;

@Injectable()
export class UserDataPurgeHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(UserDataPurgeHandler.name);

  readonly type = USER_DATA_PURGE_JOB_TYPE;

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
    private readonly prisma: PrismaService,
    private readonly notes: NotesService,
    private readonly templates: NoteTemplatesService,
    private readonly pipeline: TranscriptPipelineService,
    private readonly objects: ObjectsService,
    private readonly pat: PatService,
    private readonly aiCredentials: UserAiCredentialsService,
    private readonly searchIndex: SearchIndexService,
    private readonly userSettings: UserSettingsService,
  ) {}

  onModuleInit(): void {
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

    if (scopeIncludes(scope, 'credentials')) {
      await this.destroyCredentials(userId);
    }

    if (scopeIncludes(scope, 'notes')) {
      await this.deleteNotes(userId);
      await this.forgetFromSearchIndex(userId, SEARCH_DOC_NOTE);
    }

    if (scopeIncludes(scope, 'transcripts')) {
      await this.deleteTranscripts(userId);
      await this.forgetFromSearchIndex(userId, SEARCH_DOC_TRANSCRIPT);
    }

    if (scopeIncludes(scope, 'noteTemplates')) {
      await this.deleteNoteTemplates(userId);
    }

    if (scopeIncludes(scope, 'files')) {
      await this.deleteUnmanagedObjects(userId);
    }

    // Last, and see the header's ORDER section for why: this is the one step
    // that makes a CLAIM to the user ("you are starting over") rather than
    // destroying something, so it may only run after the destruction it
    // narrates has actually been carried out.
    if (scopeIncludes(scope, 'onboarding')) {
      await this.resetOnboarding(userId);
    }

    this.logger.warn(
      `Bulk deletion of scope "${scope}" for user ${userId} has been queued out ` +
        `(job ${job.id})`,
    );
  }

  // ===========================================================================
  // The semantic index (#188, epic #165)
  // ===========================================================================

  /**
   * Drop every `search_chunks` / `search_index_state` row for one category of
   * this user's documents.
   *
   * ⚠ THIS IS NOT REDUNDANT WITH THE FAN-OUT ABOVE, and the reason is the same
   * one that makes every other step of this handler belt-and-braces about the
   * `Restrict` keys. `deleteNotes`/`deleteTranscripts` soft-delete each document
   * and QUEUE a per-item `note.purge`/`transcript.purge`, and each of those
   * handlers calls `SearchIndexService.forget` itself — so on the happy path
   * this call finds nothing left to do. But those jobs run LATER, and a job can
   * exhaust its attempts. A user who pressed a button that said their
   * transcripts would be destroyed must not be left with the TEXT of those
   * transcripts sitting in `search_chunks` because a purge job three hops away
   * gave up quietly. Every document of this kind owned by this user is on its
   * way out, so deleting all of their index rows now is the same set reached
   * sooner, not a guess.
   *
   * ⚠ IT DELETES ROWS RATHER THAN FANNING OUT, which is the one place this
   * handler's usual "never reimplement byte deletion here" rule does not apply:
   * there are no bytes. A chunk is a row of text and a vector in this database,
   * with no object storage behind it and no provider copy to revoke — the whole
   * reason `transcript.purge` may not be shortcut is that it deletes
   * multi-gigabyte objects whose only remaining reference is the row this
   * handler would otherwise destroy first. Nothing of that shape exists here.
   *
   * ⚠ NOT CALLED FOR THE `files` SCOPE. An uploaded file is not a searchable
   * document in this epic — only transcripts and notes are chunked — so there
   * is nothing of its owner's in these tables to remove, and a sweep by owner
   * alone would delete the index rows of documents the user did NOT ask to
   * delete.
   *
   * Never throws into the purge: the documents are already soft-deleted and
   * queued, and failing a destructive job part-way because a cleanup read lost
   * a race would leave the user with a `failed` row and no idea which half ran.
   * A leftover index row is a storage cost the per-item purge still covers.
   */
  private async forgetFromSearchIndex(
    userId: string,
    documentType: typeof SEARCH_DOC_NOTE | typeof SEARCH_DOC_TRANSCRIPT,
  ): Promise<void> {
    try {
      const forgotten = await this.searchIndex.forgetOwnerDocuments(userId, documentType);

      if (forgotten > 0) {
        this.logger.log(
          `User ${userId}: ${forgotten} ${documentType}(s) removed from the semantic index`,
        );
      }
    } catch (error) {
      this.logger.error(
        `User ${userId}: could not clear the semantic index for ${documentType}s: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ===========================================================================
  // Step 1 — credentials (`everything` only)
  // ===========================================================================

  /**
   * Erase every AI provider key and revoke every personal access token.
   *
   * Both go through the service that owns the rows rather than through
   * `prisma` directly: `UserAiCredentialsService.removeAll` because a key is
   * encrypted and audited by that module, and `PatService.revokeAllForUser`
   * because revoking (not deleting) is that module's deliberate choice and this
   * file should not be the second place that decision is made.
   */
  private async destroyCredentials(userId: string): Promise<void> {
    const aiKeys = await this.aiCredentials.removeAll(userId);
    const tokens = await this.pat.revokeAllForUser(userId);

    await this.audit(userId, 'user_data:credentials_destroyed', {
      aiKeys,
      accessTokens: tokens,
    });

    this.logger.warn(
      `User ${userId}: removed ${aiKeys} AI key(s) and revoked ${tokens} access token(s)`,
    );
  }

  // ===========================================================================
  // Step 2 — notes
  // ===========================================================================

  /**
   * Soft-delete every live note this user owns and hand each to `note.purge`.
   *
   * ⚠ `status: 'generating'` IS NOT EXCLUDED — see the header's force section.
   * A generation still running against a note that has just become `deleting`
   * finishes or fails against a row `note.purge` then removes; `note.generate`
   * is `maxAttempts: 1`, so there is no retry to outlive the purge, and
   * `notes.housekeeping` re-queues any note left in `deleting` without a live
   * purge job. The alternative — skipping generating notes — leaves the user
   * with notes they asked to be rid of and no indication why.
   */
  private async deleteNotes(userId: string): Promise<void> {
    let deleted = 0;

    for (let batch = 0; batch < USER_DATA_PURGE_MAX_BATCHES; batch += 1) {
      const rows = await this.prisma.note.findMany({
        where: { ownerId: userId, deletedAt: null },
        select: { id: true },
        take: USER_DATA_PURGE_BATCH,
      });

      if (rows.length === 0) {
        if (deleted > 0) {
          await this.audit(userId, 'user_data:notes_deleted', { count: deleted });
        }

        this.logger.log(`User ${userId}: ${deleted} note(s) soft-deleted and queued for purge`);

        return;
      }

      const ids = rows.map((row) => row.id);

      // ⚠ BEFORE THE SOFT DELETE, NOT AFTER. `notes.source_note_id` is
      // `Restrict`, so `note.purge` cannot remove the row while a derived note
      // points at it — and the derived note may well be one of the rows in a
      // LATER batch, whose own purge is equally blocked. Clearing first turns
      // a mutual deadlock between two purge jobs into two ordinary deletes.
      //
      // No `ownerId` filter: a note derived from one of these may belong to
      // somebody the transcript was shared with. It keeps its text and loses
      // the link — see the header.
      await this.prisma.note.updateMany({
        where: { sourceNoteId: { in: ids } },
        data: { sourceNoteId: null },
      });

      await this.prisma.note.updateMany({
        where: { id: { in: ids } },
        data: { status: 'deleting', deletedAt: new Date() },
      });

      await this.enqueuePurges(ids, NOTE_PURGE_JOB_TYPE, NOTE_SUBJECT_TYPE, (id) =>
        this.notes.enqueuePurge(id),
      );

      deleted += ids.length;
    }

    throw new Error(
      `Bulk note deletion for user ${userId} did not converge after ` +
        `${USER_DATA_PURGE_MAX_BATCHES} batches`,
    );
  }

  // ===========================================================================
  // Step 3 — transcripts
  // ===========================================================================

  /**
   * Soft-delete every live transcript this user owns and hand each to
   * `transcript.purge`.
   *
   * ⚠ THE DEPENDENT-NOTE CHECK `TranscriptsService.remove` RUNS IS DELIBERATELY
   * ABSENT, replaced by clearing the pointer it would have refused over.
   */
  private async deleteTranscripts(userId: string): Promise<void> {
    let deleted = 0;

    for (let batch = 0; batch < USER_DATA_PURGE_MAX_BATCHES; batch += 1) {
      const rows = await this.prisma.transcript.findMany({
        where: { ownerId: userId, deletedAt: null },
        select: { id: true },
        take: USER_DATA_PURGE_BATCH,
      });

      if (rows.length === 0) {
        if (deleted > 0) {
          await this.audit(userId, 'user_data:transcripts_deleted', { count: deleted });
        }

        this.logger.log(
          `User ${userId}: ${deleted} transcript(s) soft-deleted and queued for purge`,
        );

        return;
      }

      const ids = rows.map((row) => row.id);

      // ⚠ EVERY NOTE, NOT JUST SURVIVING ONES AND NOT JUST THIS USER'S.
      //
      // Another user's note: it was generated from a transcript they were
      // shared, and it keeps its content and loses its provenance link. That
      // is the deliberate trade described in the header — the owner's right to
      // delete their own recording outranks a stranger's pointer to it, and
      // deleting the stranger's note instead would be far worse.
      //
      // This user's own already-soft-deleted note: it is queued for
      // `note.purge` but its row still exists and still holds the `Restrict`
      // reference, so leaving it would make the two purge jobs race — whichever
      // runs second wins, and the loser is a foreign-key violation in a job
      // list. Clearing removes the race rather than ordering it.
      await this.prisma.note.updateMany({
        where: { sourceTranscriptId: { in: ids } },
        data: { sourceTranscriptId: null },
      });

      await this.prisma.transcript.updateMany({
        where: { id: { in: ids } },
        data: { status: 'deleting', deletedAt: new Date() },
      });

      await this.enqueuePurges(
        ids,
        TRANSCRIPT_PURGE_JOB_TYPE,
        TRANSCRIPT_SUBJECT_TYPE,
        (id) => this.pipeline.enqueuePurge(id),
      );

      deleted += ids.length;
    }

    throw new Error(
      `Bulk transcript deletion for user ${userId} did not converge after ` +
        `${USER_DATA_PURGE_MAX_BATCHES} batches`,
    );
  }

  // ===========================================================================
  // Step 4 — note templates
  // ===========================================================================

  /**
   * Delete the user's OWN custom templates, through the path that already knows
   * when a template must be archived instead.
   *
   * ⚠ REACHED BY `content` AND `everything` ONLY. The narrow `notes` scope
   * deliberately does not come here — a template is reusable configuration with
   * its own settings destination, not note content, and "Delete notes" silently
   * emptying a page the user did not open is the surprise a Danger Zone can
   * least afford. `scopeIncludes` carries the full argument.
   *
   * ⚠ BUILT-INS ARE UNREACHABLE HERE BY CONSTRUCTION: the query filters on
   * `ownerId: userId`, and a built-in has `ownerId IS NULL`. It is not that
   * `NoteTemplatesService.remove` would refuse them (it would, with a 403) —
   * they are never selected, so no request to delete one is ever made.
   *
   * ⚠ SOME TEMPLATES WILL BE ARCHIVED RATHER THAN DELETED, AND THAT IS
   * CORRECT-BUT-TEMPORARY. `remove` archives while any note still names the
   * template, and step 2's notes are at that moment soft-deleted rather than
   * gone — their purge jobs are still queued. So a run that deletes notes and
   * templates together leaves the templates archived (invisible in the normal
   * catalogue, still the user's rows). A later run — this handler is
   * re-entrant, and `POST /api/user-data/deletions` is the button — finds the
   * notes actually gone and deletes them. Deleting them regardless was
   * rejected: it would put a second, contradictory answer to "may this template
   * go?" in this file, and the one in `note-templates.service.ts` exists so a
   * note never loses the record of what produced it.
   */
  private async deleteNoteTemplates(userId: string): Promise<void> {
    let removed = 0;
    let archived = 0;
    const skipped = new Set<string>();

    for (let batch = 0; batch < USER_DATA_PURGE_MAX_BATCHES; batch += 1) {
      const rows = await this.prisma.noteTemplate.findMany({
        where: {
          ownerId: userId,
          ...(skipped.size > 0 ? { id: { notIn: [...skipped] } } : {}),
        },
        select: { id: true },
        take: USER_DATA_PURGE_BATCH,
      });

      if (rows.length === 0) {
        if (removed > 0 || archived > 0) {
          await this.audit(userId, 'user_data:note_templates_deleted', {
            deleted: removed,
            archived,
          });
        }

        this.logger.log(
          `User ${userId}: ${removed} note template(s) deleted, ${archived} archived`,
        );

        return;
      }

      for (const row of rows) {
        try {
          const outcome = await this.templates.remove(userId, row.id);

          if (outcome.outcome === 'archived') {
            // ⚠ RECORDED AS SKIPPED so the next page moves past it. An
            // archived row still matches `ownerId: userId`, so without this
            // the query returns the same page forever and the batch bound
            // below would be the only thing stopping the loop.
            skipped.add(row.id);
            archived += 1;
          } else {
            removed += 1;
          }
        } catch (error) {
          // One damaged template must not stop the rest — the same posture
          // `notes.housekeeping` takes towards a single bad row. It is
          // recorded and skipped, and the user can run the deletion again.
          skipped.add(row.id);

          this.logger.warn(
            `Could not remove note template ${row.id} for user ${userId}: ${describe(error)}`,
          );
        }
      }
    }

    throw new Error(
      `Bulk note template deletion for user ${userId} did not converge after ` +
        `${USER_DATA_PURGE_MAX_BATCHES} batches`,
    );
  }

  // ===========================================================================
  // Step 5 — unmanaged storage objects
  // ===========================================================================

  /**
   * Delete the caller's plain uploads: bytes and row, through `ObjectsService`.
   *
   * ⚠ `managedBy: null` IS PART OF THE QUERY, not a check after the fact. A
   * transcript's source audio, a note's rendered export and every other
   * module-owned object are `managed_by`-stamped precisely so they can only be
   * removed by the module that understands them (issue #21), and their bytes
   * are already on their way out through the purge jobs steps 2 and 3 queued.
   * Selecting them here would either 409 out of `ObjectsService.delete` or, if
   * that check were ever relaxed, delete a live transcript's audio.
   *
   * `ObjectsService.delete` is used rather than a narrower in-process method
   * precisely BECAUSE of that 409: it can never fire on this query's rows, so
   * reusing the ordinary path costs nothing and keeps one implementation of
   * "remove an object's bytes, its row, its chunks and write the audit event".
   */
  private async deleteUnmanagedObjects(userId: string): Promise<void> {
    let deleted = 0;
    const failed = new Set<string>();

    for (let batch = 0; batch < USER_DATA_PURGE_MAX_BATCHES; batch += 1) {
      const rows = await this.prisma.storageObject.findMany({
        where: {
          uploadedById: userId,
          managedBy: null,
          ...(failed.size > 0 ? { id: { notIn: [...failed] } } : {}),
        },
        select: { id: true },
        take: USER_DATA_PURGE_BATCH,
      });

      if (rows.length === 0) {
        if (deleted > 0 || failed.size > 0) {
          await this.audit(userId, 'user_data:files_deleted', {
            count: deleted,
            failed: failed.size,
          });
        }

        this.logger.log(
          `User ${userId}: ${deleted} unmanaged file(s) deleted, ${failed.size} could not be`,
        );

        return;
      }

      for (const row of rows) {
        try {
          await this.objects.delete(row.id, userId);
          deleted += 1;
        } catch (error) {
          // ⚠ RECORDED AND EXCLUDED FROM THE NEXT PAGE. An object whose bytes
          // the provider refuses to delete keeps its row, so without this the
          // same page is selected forever. Tolerating the failure rather than
          // throwing is the same choice every other step makes: one
          // unreachable file must not strand the rest of a deletion.
          failed.add(row.id);

          this.logger.warn(
            `Could not delete storage object ${row.id} for user ${userId}: ${describe(error)}`,
          );
        }
      }
    }

    throw new Error(
      `Bulk file deletion for user ${userId} did not converge after ` +
        `${USER_DATA_PURGE_MAX_BATCHES} batches`,
    );
  }

  // ===========================================================================
  // Step 6 — onboarding state (`everything` only)
  // ===========================================================================

  /**
   * Forget that this user has ever been onboarded.
   *
   * ⚠ IT CLEARS EXACTLY ONE NAMESPACE, AND THAT IS THE WHOLE CONTRACT.
   * `theme`, `profile`, `navigation`, `notifications` and `dataTables` are
   * untouched — the account still works, the user is still signed in looking
   * at it, and "delete my data" is not "reset my preferences". A widening of
   * this call to the whole settings row is pinned against in
   * `user-data-purge.handler.spec.ts` for exactly that reason: it would be a
   * one-word change here and an invisible, unasked-for change to the user's
   * screen.
   *
   * ⚠ IT REUSES `UserSettingsService.patchSettings` AND HAND-WRITES NO JSONB
   * EDIT. `{ onboarding: null }` is already a supported, tested operation
   * (issue #272): `onboardingPatchSchema` is `.nullable()`, `mergeOnboarding`
   * returns `undefined` for `null`, and `patchSettings` then omits the key
   * entirely rather than storing `{}`. That collapse-to-ABSENT is precisely
   * the state a wipe wants, because absent is how "never onboarded" is spelled
   * throughout epic #271 — a stored `{}` would be a PRESENT `onboarding` key
   * and would read as "onboarded, with no opinions". A second, independently
   * written namespace removal in this file is the duplication `scopeIncludes`'s
   * own header argues against, and this one would be worse than most: it would
   * have to reproduce the collapse rule from memory, and getting it wrong
   * fails silently and permanently.
   *
   * ⚠ NO `If-Match`. `patchSettings`' third argument is an optimistic
   * concurrency expectation, and this call has none to state: it is the server
   * acting on a job the user queued minutes ago, not a browser tab racing
   * another tab. Passing a version read moments earlier would turn a user who
   * happened to toggle their theme mid-deletion into a `failed` purge.
   *
   * ⚠ IT THROWS RATHER THAN SWALLOWING, unlike `forgetFromSearchIndex` above,
   * and the asymmetry is about POSITION rather than importance. That one runs
   * BETWEEN destructive steps, where failing would leave the user with a
   * `failed` row and no idea which half ran. This one runs last, after every
   * destructive step has completed and written its own audit row, so a failure
   * here is unambiguous: everything was deleted and the reset did not happen.
   * Reporting that honestly costs a `failed` job the user can re-request — the
   * handler is re-entrant, so the second run deletes nothing and retries just
   * this. Swallowing would cost the opposite: onboarding state surviving a full
   * wipe with nothing anywhere saying so, which is the exact bug this step was
   * added to fix.
   */
  private async resetOnboarding(userId: string): Promise<void> {
    await this.userSettings.patchSettings(userId, { onboarding: null });

    await this.audit(userId, 'user_data:onboarding_reset', {});

    this.logger.log(
      `User ${userId}: first-run onboarding state cleared — the checklist and ` +
        `welcome surfaces will be offered again`,
    );
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Queue a per-item purge for each id a live purge job does not already cover.
   *
   * ⚠ ONE `job.findMany` FOR THE WHOLE BATCH, never one lookup per id — the
   * shape `notes.housekeeping`'s `requeueStalledPurges` established, and for
   * the same reason: a per-row query turns a sweep into an N+1 against the very
   * table the queue is contending on.
   *
   * The check is an optimisation rather than a correctness requirement —
   * `JobsService.enqueue` deduplicates on `(type, subjectType, subjectId)`
   * while a job is `pending`/`running` anyway — but it saves several hundred
   * insert-then-conflict-then-re-read round trips per batch on a re-run.
   */
  private async enqueuePurges(
    ids: string[],
    jobType: string,
    subjectType: string,
    enqueue: (id: string) => Promise<void>,
  ): Promise<void> {
    const live = await this.prisma.job.findMany({
      where: {
        type: jobType,
        subjectType,
        subjectId: { in: ids },
        status: { in: ['pending', 'running'] },
      },
      select: { subjectId: true },
    });

    const covered = new Set(live.map((entry) => entry.subjectId));

    for (const id of ids) {
      if (covered.has(id)) continue;

      await enqueue(id);
    }
  }

  /**
   * One audit row per destructive step.
   *
   * `targetType: 'user'` and `targetId` the user's own id, matching both
   * `UserDataService.audit` and the job's own `subject_type`/`subject_id`: the
   * whole trail for one deletion is greppable by the account it happened to,
   * which is the only key that spans six tables.
   */
  private async audit(
    userId: string,
    action: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action,
        targetType: 'user',
        targetId: userId,
        meta: meta as Prisma.InputJsonValue,
      },
    });
  }
}

/** Anything thrown, as a message. JavaScript lets you throw a string. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Re-exported so a reader of this file does not have to chase the union. */
export type { UserDataScope };

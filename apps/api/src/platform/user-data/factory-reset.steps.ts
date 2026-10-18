import { registerFactoryResetStep } from '@marinoscar/platform-api/user-data';
import type { FactoryResetStepDef } from '@marinoscar/platform-api/user-data';
import { seedNoteTemplates } from '@marinoscar/kvox-api/notes/templates';
import { deleteGrantsForResources } from '@marinoscar/platform-api/sharing';

import { TRANSCRIPT_RESOURCE_TYPE } from '../../app-registrations/sharing';

import { KVOX_STORAGE_STEP } from '../../kvox-objects/factory-reset-storage.step';

// =============================================================================
// This app's steps of the platform's admin factory reset (issue #562)
// =============================================================================
//
// `admin.factory_reset` (`@marinoscar/platform-api/user-data`) wipes inline owner
// models per user, every `org` model and every user but the actor, then every
// storage object outside the `survivesFactoryReset` prefixes. It was written for an
// app whose content lives in inline models and one storage-object model flagged
// `storageObjects: true`. This app has neither, and left alone the reset is wrong on
// six counts (verified against the real registries, `test/user-data/factory-reset.db.spec.ts`):
//
//   1. THE CONTENT IS DELEGATED. `Transcript`, `Note` and every `Kg*` model hint a
//      delegate job (`user.data.purge`'s way of handing them to their module). The reset
//      never enqueues one, and step 1 has already deleted every pending job. So the
//      ACTOR's transcripts, notes and graph, and their search index rows, were never
//      touched; "Every user's data, yours included" was false.
//
//   2. `StorageObject` IS NOT `storageObjects: true` (a user's deletion must not collect
//      objects a transcript or note still owns), so the platform sees no storage plan:
//      its storage step (step 7) never runs, no byte is deleted from the bucket, and the
//      org step (step 5) lists `StorageObject` as an ordinary `org` model and runs
//      `storage_objects.deleteMany({})`. Transcripts, note sources and exports, version
//      snapshots and graph exports all reference `storage_objects` with `onDelete: Restrict`,
//      so on any deployment that holds a transcript that statement fails on the foreign key
//      and the job fails every attempt. (The hint now says `factoryReset: 'keep'`, see
//      `user-data.manifest.ts`, so step 5 leaves the table alone and the sweep below owns it.)
//
//   3. THE ACTOR IS NEVER CASCADED. Every other user's rows go with the user row, but the
//      actor stays, so the actor's content must be deleted by statements the steps send. Those
//      statements meet `Restrict` columns (`notes.source_note_id`, `notes.source_transcript_id`,
//      `transcript_segments.speaker_id`, the object references) that Postgres checks
//      immediately, so a whole-table `deleteMany` is order-dependent. The content step clears
//      the note references first and deletes children before parents.
//
//   4. THE SEARCH INDEX IS NOT CASCADED. `search_chunks.document_id` and
//      `search_index_state.document_id` carry no foreign key (a polymorphic reference), so
//      nothing removes them with a transcript or a user, and the indexed text of a deleted
//      conversation would stay. (`search_embeddings` cascade from their chunk.)
//
//   5. TRANSCRIPT SHARES ARE NOT CASCADED. A share is a platform `grants` row
//      (`resource_type = 'transcript'`, `resource_id` = the transcript id) with no foreign key,
//      so deleting the transcripts leaves their grants, share-link token hashes and ciphertext
//      included, until the platform's `sharing.grants.prune` job sweeps them. The content step
//      deletes them with `deleteGrantsForResources`, as `transcript.purge` does.
//
//   6. THE BUILT-IN NOTE TEMPLATES GO. The platform's step 6 deletes every OWNER-LESS row of
//      an inline owner model; for `NoteTemplate` those are the built-in templates (seeded
//      with `owner_id` null), which are configuration, so the deployment was left without
//      them until the next seed.
//
// WHAT THE STEPS DO, in the handler's order:
//
//   kvox.content          phase before-users   everything the users owned that the delegates
//                                              would delete, for EVERY user, in foreign-key
//                                              order, inside the step's transaction
//   kvox.storage-objects  phase deployment     every storage object outside the surviving
//                                              prefixes: bytes, then the row (the platform's
//                                              step 7, which this app cannot reach). Lives in
//                                              `kvox-objects/factory-reset-storage.step.ts`: that
//                                              module alone may name the storage tables
//                                              (`test/kvox-objects/storage-boundary.spec.ts`)
//   kvox.note-templates   phase deployment     re-seeds the built-in note templates the
//                                              platform's step 6 deleted (fixed ids, idempotent)
//
// THE KNOWLEDGE GRAPH. The graph's write rule (every write through `GraphWriteService`,
// `kg.migrate` aside) is about producing and editing graph rows. Erasing them is a
// different act, and this app already does it without the service: `kg.purge`
// (`KgPurgeService`) and the `owner_id ... ON DELETE CASCADE` of every `kg_*` table both
// delete rows directly. What must hold is the no-orphans trigger,
// `kg_assert_has_evidence` (migration `20260926030200_kg_evidence_invariant`): it is
// DEFERRED and, at COMMIT, re-reads each subject's CURRENT row, so a subject deleted in
// the same transaction finds no row and passes. the `kg_evidence` notes of `docs/specs/ontology.md` say the same:
// delete evidence after, or together with, its subject. This step deletes every entity,
// relation and item and then ALL evidence in ONE transaction, so the trigger has nothing to refuse
// (`test/user-data/factory-reset.db.spec.ts` forces it with `SET CONSTRAINTS ALL IMMEDIATE`).
//
// RETRY SAFETY. Every statement is a `deleteMany` by predicate, so a retried step deletes
// what is left. The sweep selects what is still there on every page.
// =============================================================================

/** Transcript ids read per page when their grants are deleted. */
const TRANSCRIPT_ID_PAGE = 2000;

/** `deleteMany` on one model, returning the count. */
async function wipe(tx: any, model: string, where: Record<string, unknown> = {}): Promise<number> {
  return (await tx[model].deleteMany({ where })).count as number;
}

/**
 * Everything the users owned that this app's delegate jobs would delete, for every user, in
 * foreign-key order. See the header for the reasons and the graph's no-orphans trigger.
 */
export const KVOX_CONTENT_STEP: FactoryResetStepDef = {
  id: 'kvox.content',
  phase: 'before-users',
  description:
    'Transcripts, notes, custom note templates, the search index and the knowledge graph of every user, the actor included.',
  summary:
    'Every recording and transcript, note and custom note template, the search index and the knowledge graph',
  async run(tx: any): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    // The vendor's copy of a transcript is not ours to delete from a step (the credential and
    // the client live behind `TranscriptionRuntimeService`); say how many are left, so the
    // administrator can remove them at the provider.
    counts.providerCopiesRemaining = await tx.transcript.count({
      where: { providerJobId: { not: null }, remoteDeletedAt: null },
    });

    // 1. The search index. No foreign key points at a document, so nothing else removes these.
    counts.searchChunks = await wipe(tx, 'searchChunk'); // search_embeddings cascade from the chunk
    counts.searchIndexState = await wipe(tx, 'searchIndexState');

    // 2. The graph: every subject, then its evidence, in this one transaction (the spec's rule:
    //    delete evidence after, or together with, its subject; see the header).
    await wipe(tx, 'kgMention');
    await wipe(tx, 'kgProposalItem');
    await wipe(tx, 'kgProposal');
    await wipe(tx, 'kgMerge');
    await wipe(tx, 'kgDistinctPair');
    await wipe(tx, 'kgEntityDigest');
    await wipe(tx, 'kgEntityView');
    counts.graphExports = await wipe(tx, 'kgExport'); // Restrict to storage_objects: gone before the sweep
    await wipe(tx, 'kgGraphLayout');
    counts.graphItems = await wipe(tx, 'kgItem');
    counts.graphRelations = await wipe(tx, 'kgRelation');
    await wipe(tx, 'kgEntityAlias');
    counts.graphEntities = await wipe(tx, 'kgEntity');
    await wipe(tx, 'kgEvidence');
    await wipe(tx, 'kgAttributeDef');

    // 3. Notes. `source_note_id` and `source_transcript_id` are Restrict, so clear them first.
    await wipe(tx, 'noteExport'); // Restrict to storage_objects
    await wipe(tx, 'noteVersion');
    await tx.note.updateMany({
      where: { OR: [{ sourceNoteId: { not: null } }, { sourceTranscriptId: { not: null } }] },
      data: { sourceNoteId: null, sourceTranscriptId: null },
    });
    counts.notes = await wipe(tx, 'note'); // generations cascade
    await wipe(tx, 'noteGeneration'); // the ones that never had a note
    // The platform's per-user pass keeps a template a note still named; no note is left.
    counts.noteTemplates = await wipe(tx, 'noteTemplate', { ownerId: { not: null } });

    // 4. Transcripts. Their grants first: no foreign key, so nothing else removes them. Page the
    //    ids by cursor so a large deployment never loads them all; only the platform helper
    //    touches the grants table.
    counts.transcriptGrants = 0;
    for (let cursor: string | undefined; ; ) {
      const page: { id: string }[] = await tx.transcript.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: TRANSCRIPT_ID_PAGE,
        ...(cursor ? { where: { id: { gt: cursor } } } : {}),
      });
      if (page.length === 0) break;
      counts.transcriptGrants += await deleteGrantsForResources(
        tx,
        TRANSCRIPT_RESOURCE_TYPE,
        page.map((t) => t.id),
      );
      cursor = page[page.length - 1].id;
    }

    // A segment Restricts its speaker, so segments first.
    await wipe(tx, 'transcriptNameCheck'); // suggestions cascade
    await wipe(tx, 'transcriptExport'); // Restrict to storage_objects
    await wipe(tx, 'transcriptVersion'); // Restrict to storage_objects
    await wipe(tx, 'transcriptSegment');
    await wipe(tx, 'transcriptSpeaker');
    counts.transcripts = await wipe(tx, 'transcript');

    return counts;
  },
};

/**
 * The platform's step 6 deletes the owner-less rows of every inline owner model. For
 * `NoteTemplate` those are the BUILT-IN templates (`owner_id` null), which are configuration
 * seeded with fixed ids, not a user's data. Seeding them again (idempotent) restores the fresh
 * install the reset promises. Registered in the `deployment` phase, which runs after step 6.
 */
export const KVOX_NOTE_TEMPLATES_STEP: FactoryResetStepDef = {
  id: 'kvox.note-templates',
  phase: 'deployment',
  description: 'Re-seeds the built-in note templates that the owner-less sweep of the reset deleted.',
  async run(tx: any): Promise<Record<string, number>> {
    const { created, updated } = await seedNoteTemplates(tx);

    return { builtInTemplatesRestored: created, builtInTemplatesPresent: updated };
  },
};

/** The steps, in registration order. */
export const KVOX_FACTORY_RESET_STEPS: readonly FactoryResetStepDef[] = [
  KVOX_CONTENT_STEP,
  KVOX_STORAGE_STEP,
  KVOX_NOTE_TEMPLATES_STEP,
];

for (const step of KVOX_FACTORY_RESET_STEPS) {
  registerFactoryResetStep(step);
}

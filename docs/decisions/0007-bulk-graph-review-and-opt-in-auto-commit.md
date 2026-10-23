# ADR-0007: Bulk graph review and opt-in auto-commit for note libraries

- Status: Accepted
- Date: 2026-10-23
- Related issues: epic #708, #709, #717, #718

## Context

The knowledge graph and Ask are the core of KVox Desktop. A person imports existing note files, singly or as note libraries (folders that are rescanned and, on Desktop, watched; [../specs/notes.md §8.8](../specs/notes.md#88-note-libraries-and-import-batches-epic-708)). Every imported note is search-indexed and emits `kvox.notes.note_ready` for automatic graph extraction.

Extraction produces a draft proposal per note. The ontology spec makes proposal commit the only write path into the graph and rejects auto-commit ([../specs/ontology.md](../specs/ontology.md) §3.6 and "Rejected alternatives"). Per-note review does not scale to a library of hundreds of notes: the person would open hundreds of drafts to accept rows that are plainly correct.

## Decision

Two ways to commit many proposals. Both go through `ProposalCommitService` and `GraphWriteService`; neither is a new write path.

1. **Cross-proposal Review Queue (default).** `GET /api/graph/review-queue` lists open drafts across notes. `POST /api/graph/proposals/commit-batch` takes one of `batchId`, `libraryId` or `proposalIds` and `policy: 'safe'`. A person triggers it once per batch; it accepts the safe rows of every draft. Each proposal commits in its own Serializable transaction, never one transaction for the batch.
2. **Opt-in, default-off auto-commit per library.** `kvox.graph.proposal_drafted` has a subscriber that only enqueues the job `kg.autocommit`. The job applies the same safe policy when all of these hold: `library.auto_commit` is true, the user holds `graph:write`, the graph is enabled, and the proposal is not stale. The subscriber does no I/O itself.

**The safe policy** never accepts:

- a `sensitive` PersonFact (it is never bulk-accepted, bulk-imported or exported), or a row of a review-only type such as the personal domain;
- a closing;
- an ambiguous resolution or a merge into an existing entity;
- a row below the user's `graphPreferences.review.minConfidence` (default 0.7);
- a row the pre-check flagged;
- a relation, item or closing whose endpoint entity is not itself accepted;
- a row of a stale proposal.

Each row that waits carries one reason: `sensitive`, `closing`, `merge`, `ambiguous`, `low_confidence`, `flagged` or `blocked_endpoint` (`SAFE_POLICY_WAIT_REASONS`). A stale proposal is skipped whole.

Those rows stay available for a person. `ProposalCommitService.commit` ignores undecided rows and marks the whole proposal `committed`, so after each successful commit the batch commit moves the rows that wait into a new draft of the same note (`remainderProposalId`; the rows keep their ids and evidence). Auto-commit does the same. [../specs/ontology.md §19.2](../specs/ontology.md#192-row-level-overrides-in-the-review-panel) has the detail.

Other rules:

- Bulk extraction is queued at the lower priority `KG_EXTRACT_BULK_PRIORITY = 50`, so imports and search indexing run first. The reconcile job `kg.library_reconcile` queues extraction again when `extracted_version < current_version`.
- Audit actions: `graph:autocommit` (the job) and `graph.proposals_batch_committed` (`commit-batch`) record ids and counts only, never statements or evidence text. The import itself is audited as `note:library_import`.
- The notes slice publishes `kvox.notes.import_batch_settled` when a batch settles; the graph slice answers with `kg.library_reconcile`, a job that only enqueues extraction for library notes whose `extracted_version` is behind. `kvox.graph.proposal_drafted` is raised by `kg.extract` after the draft commits.
- Auto-commit is a per-library switch, off for every library until a person turns it on.

## Consequences

- A library import is reviewed in one sitting: one confirmation per batch instead of one per note.
- The no-orphans invariant holds: the deferred `kg_assert_has_evidence` trigger still refuses an accepted row without evidence at `COMMIT`.
- The review gate is skippable for safe rows in a library whose owner opted in. This is a deliberate, bounded departure from the ontology spec's original stance; its edges are the safe policy and the per-library switch.
- A partially failed batch leaves some proposals committed and others open. Each is independent, and the response reports per-proposal outcomes.
- A committed proposal can leave a remainder draft behind: the review queue then shows the same note again with only the rows that need a person.
- The safe policy lives in a package ([ADR-0001](0001-packages-first.md)); a host cannot widen it.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Full auto-commit of every extracted row | Commits sensitive facts, closings and ambiguous merges with no person; breaks the unsupported-assertion guarantee. |
| Per-note review only | Does not scale to libraries; people stop reviewing or never import. |
| One giant transaction for a batch | One stale or invalid proposal rolls back all the others; long Serializable transactions conflict with concurrent edits. |
| A global (not per-library) auto-commit setting | Too coarse; a person trusts one folder of their own notes, not every import. |
| Auto-commit inside the `proposal_drafted` subscriber | Work in an event body violates the job-queue rule; the subscriber only enqueues. |

## Enforcement

- Safe-policy tests in the graph slice: each excluded row kind stays in the draft after `commit-batch` and after `kg.autocommit`.
- A sensitive-PersonFact invariant test: a sensitive row is never accepted by either path, even when its id is passed explicitly.
- `kg.autocommit` no-ops when `auto_commit` is false, the note has no library, `graph:write` is missing, the graph is disabled or the proposal is stale.
- Remainder-draft test (`proposal-batch-commit.service.spec.ts`): the rows that wait are reported as a new draft (`remainderProposalId`) after the commit.
- The `cron-enqueue-only` and `on-event-no-io` conformance suites (`apps/api/test/conformance.spec.ts`) prove the `proposal_drafted` subscriber only enqueues.
- Graph-write tests prove both paths commit through `GraphWriteService`.
- Review item: no new write path into `kg_entities`, `kg_relations` or `kg_items`.

## Related issues

#708, #709, #717, #718.

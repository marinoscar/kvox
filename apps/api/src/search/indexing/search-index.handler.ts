import { randomUUID } from 'node:crypto';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job, SearchIndexStatus } from '@prisma/client';

import { AiAuthError, RateLimitError } from '../../ai/ai-errors';
import { AiProviderRegistry } from '../../ai/ai-provider.registry';
import { AiSettingsService } from '../../ai/ai-settings.service';
import {
  createProviderContext,
  EMBEDDING_DIMENSIONS,
  type AiEmbeddingCapability,
  type AiProvider,
} from '../../ai/providers/ai-provider.interface';
import { UserAiCredentialsService } from '../../ai/user-ai-credentials.service';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { aiProviderThrottleKey } from '../../notes/job-types';
import { PrismaService } from '../../prisma/prisma.service';
import {
  chunkNote,
  chunkTranscript,
  fingerprintDocument,
  type Chunk,
} from '../chunking';
import {
  readSearchIndexPayload,
  SEARCH_DOC_NOTE,
  SEARCH_DOC_TRANSCRIPT,
  SEARCH_INDEX_JOB_TYPE,
  SEARCH_REASON_DIMENSION_MISMATCH,
  SEARCH_REASON_EMBEDDING_UNSUPPORTED,
  SEARCH_REASON_KEY_INVALID,
  SEARCH_REASON_KEY_MISSING,
  SEARCH_REASON_NOT_CONFIGURED,
  type SearchDocumentType,
} from './job-types';
import { SearchIndexService } from './search-index.service';

// =============================================================================
// `search.index` (issue #188, epic #165) — the job that makes a document
// semantically searchable, and records why when it cannot
// =============================================================================
//
// Chunk a transcript or a note, embed the chunks WHOSE TEXT ACTUALLY MOVED, and
// leave one `search_index_state` row saying what happened. Everything expensive
// about this job is the middle clause.
//
// -----------------------------------------------------------------------------
// SERVER-ONLY, PERMANENTLY — NEITHER `nodeResultSchema` NOR `persistNodeResult`
// -----------------------------------------------------------------------------
//
// This handler declares neither member, so `JobHandlerRegistry.serverOnlyTypes()`
// reports `search.index` and no worker node can ever claim it. Eligibility is
// DERIVED from the pair (`job-handler.interface.ts`) and there is no flag able
// to disagree with the derivation.
//
// THE REASON IS THE CREDENTIAL, AND IT IS THE SAME ONE `note.generate` CARRIES.
// The key this job spends is the DOCUMENT OWNER'S OWN long-lived, account-level
// vendor key. `db.backup.run` is node-eligible because PostgreSQL can mint a
// short-lived, SELECT-only role scoped to exactly one job and destroy it
// afterwards (`db-backup/pg-job-role.broker.ts`, epic #345) — that is what a
// `nodeSecretBroker` brokers. OpenAI offers no equivalent: there is no
// job-scoped sub-key, no per-request capability token, nothing a broker could
// mint and revoke. So the only way to run this on a machine this deployment
// does not own is to ship somebody's personal API key to it, which is not an
// alternative, and the broker member has nothing to hold.
//
// This is a PROPERTY OF THE VENDOR CONTRACT, not a gap waiting on a later
// issue. Nothing about `nodeResultSchema` would be hard to write — a batch of
// float arrays validates fine — and the work (chunk, embed, hand back vectors)
// is exactly the CPU-and-network shape the node plane exists for. It is the
// secret that cannot travel. If a vendor ever ships job-scoped embedding
// credentials, a broker becomes writable and this paragraph becomes wrong;
// until then the pair stays absent.
//
// -----------------------------------------------------------------------------
// `profile: { maxAttempts: 3 }` — THE DELIBERATE INVERSE OF `note.generate`'S 1
// -----------------------------------------------------------------------------
//
// Two AI jobs, both spending the user's own key, with OPPOSITE retry policies.
// That looks like an inconsistency and is the opposite of one: the three facts
// that make `note.generate` refuse to retry are each FALSE here.
//
//   1. NON-DETERMINISM. A completion is non-deterministic, so `note.generate`'s
//      retry would produce different text than the partial stream the user
//      already watched fail — double-charging them for output nobody asked to
//      see twice. An embedding is DETERMINISTIC: the same input under the same
//      model returns the same vector, so a retry converges on the answer the
//      first attempt was computing rather than on a different one.
//
//   2. SOMEBODY WATCHING. A generation has a person in front of a stream; a
//      failed retry is a visible, confusing event. NOBODY IS WATCHING AN INDEX
//      RUN. There is no spinner, no SSE reader, no email; the only surface is
//      `search_index_state`, which a retry improves rather than contradicts.
//
//   3. THE COST OF RETRYING. This is the one that actually decides it. Content
//      addressing (`search_chunks.content_hash` + `UNIQUE (chunk_id, model)`)
//      means an attempt that embedded 300 of 400 chunks LEAVES THOSE 300
//      COMMITTED — each batch is written as it completes, deliberately not
//      wrapped in one job-long transaction — so the retry embeds 100. Retrying
//      is nearly free, and it converges.
//
// So the asymmetry is: retrying a generation is expensive and wrong, retrying
// an index is cheap and right. Giving up instead is what is expensive here — a
// document silently absent from every future search, with a `failed` row nobody
// reads.
//
// `maxRuntimeMs` is 15 minutes, and the number is argued rather than picked.
// The batch ceiling is `provider.embedding.maxBatchSize` (128 for OpenAI), so
// at a pessimistic 30 seconds per request — which is several times the real
// figure, and covers a slow day — 15 minutes is roughly 30 requests, or ~3,800
// chunks. At `MAX_CHUNK_CHARS = 1600` with 200 characters of overlap that is a
// document of about 5.3 million characters: some hundreds of hours of speech,
// far past anything this application ingests. The ceiling is not sized to the
// biggest plausible document, it is sized so that "still running" means STUCK —
// a wedged socket, a hung provider — rather than "big". The lease and its
// renewal interval are DERIVED from this number (`job-execution-profile.ts`),
// which is why there is no `leaseMs` here and must never be one.
//
// -----------------------------------------------------------------------------
// FIVE SKIPS THAT ARE NOT FAILURES, ONE FAILURE THAT IS
// -----------------------------------------------------------------------------
//
// Following `docs/specs/transcription.md` §1.6 and `note.generate`'s taxonomy
// exactly: a job that has POSITIVELY DETERMINED a permanent outcome has
// succeeded, and throwing would spend an attempt rediscovering a fact that
// cannot change. So no key, no provider, no embedding capability, a refused key
// and a vanished document all write `search_index_state` and RETURN NORMALLY.
//
// `dimension_mismatch` is the one that throws, and the difference is that it is
// a BUG rather than a fact about a deployment or an account — see
// `SEARCH_REASON_DIMENSION_MISMATCH`.
//
// A `RateLimitError` is neither: it is rethrown so `JobTerminalService` defers
// the job against the PER-USER throttle bucket without charging an attempt.
//
// -----------------------------------------------------------------------------
// THE THROTTLE KEY IS PER USER, AND A SHARED ONE WOULD LOOK RIGHT
// -----------------------------------------------------------------------------
//
// `aiProviderThrottleKey(ownerId)` (`notes/job-types.ts`), registered
// immediately before the first provider call rather than at `onModuleInit`,
// exactly as `NoteGenerateHandler` does and for the identical reason: the
// bucket cannot be named until a job is running, because the bucket is the
// USER.
//
// The shared-key version of this line is the one a reader would write from
// memory, because it is precisely what the three transcription handlers do —
// and there it is correct, since every user's transcription authenticates as
// the SAME deployment-owned AssemblyAI account against one vendor rate limit.
// Here every user brings their own vendor account with their own limit. A 429
// against user A's key is evidence about user A and about nobody else, so a
// shared `'ai-provider'` key would let one busy user's exhausted quota defer
// every other user's indexing — a relationship between the accounts that does
// not exist.
// =============================================================================

/** Fifteen minutes. Also the lease, indirectly — see the header. */
export const SEARCH_INDEX_MAX_RUNTIME_MS = 15 * 60 * 1000;

/** See the header: three, and deliberately not `note.generate`'s one. */
export const SEARCH_INDEX_MAX_ATTEMPTS = 3;

/**
 * A document loaded and chunked, ready to reconcile.
 *
 * `revision` is the narrow "has the chunker's input moved" token — see
 * {@link SearchIndexHandler.loadDocument} for why it is not `updatedAt`.
 */
interface LoadedDocument {
  ownerId: string;
  chunks: Chunk[];
  revision: string;
}

/** What a skip or failure records on `search_index_state`. */
interface Settlement {
  status: SearchIndexStatus;
  reason: string | null;
}

@Injectable()
export class SearchIndexHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(SearchIndexHandler.name);

  readonly type = SEARCH_INDEX_JOB_TYPE;

  /** See the header. Two numbers, and deliberately only two. */
  readonly profile: JobExecutionProfile = {
    maxRuntimeMs: SEARCH_INDEX_MAX_RUNTIME_MS,
    maxAttempts: SEARCH_INDEX_MAX_ATTEMPTS,
  };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly providers: AiProviderRegistry,
    private readonly settings: AiSettingsService,
    private readonly credentials: UserAiCredentialsService,
    private readonly throttle: ProviderThrottleService,
    private readonly index: SearchIndexService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);

    // ⚠ NO `registerProviderKey` HERE, exactly as in `NoteGenerateHandler` and
    // unlike every transcription handler. The bucket is per USER (see the
    // header), and a user is not known until a job is running, so the key is
    // registered inside `process` immediately before the first provider call.
  }

  // ---------------------------------------------------------------------------
  // The job
  // ---------------------------------------------------------------------------

  async process(job: Job): Promise<void> {
    const payload = readSearchIndexPayload(job.payload);

    if (!payload) {
      // A payload written by another build, or hand-edited in the admin UI.
      // There is no document to name and nothing to index; a throw would retry
      // an unreadable payload three times to reach the same conclusion.
      this.logger.warn(
        `Index job ${job.id} carries no readable document reference; nothing to do`,
      );

      return;
    }

    const { documentType, documentId } = payload;

    // -------------------------------------------------------------------------
    // 1. Whose document is it?
    // -------------------------------------------------------------------------
    //
    // ⚠ THE HEADER READ IS DELIBERATELY SEPARATE FROM THE CONTENT READ. A
    // three-hour transcript is a megabyte of segment text, and every gate below
    // this point — the master switch, the provider, the embedding capability,
    // the owner's key — can be decided from the owner id alone. Loading the
    // text first would mean pulling that megabyte through the connection on
    // every indexing attempt for every user who has never configured a key,
    // which is most of them on the day this ships.
    const ownerId = await this.loadOwner(documentType, documentId);

    if (!ownerId) {
      // Deleted, or purged, between the enqueue and now — entirely ordinary for
      // a queue that runs minutes later. Take the rows with it rather than
      // leaving an orphan `search_index_state` row no cascade will ever reach
      // (there is no foreign key on `document_id`; see `SearchIndexService`).
      this.logger.log(
        `${documentType} ${documentId} no longer exists; index job ${job.id} forgets it instead`,
      );

      await this.index.forget(documentType, documentId);

      return;
    }

    // -------------------------------------------------------------------------
    // 2. Can anything be embedded at all? Three deployment facts, then one
    //    account fact — cheapest and most permanent first.
    // -------------------------------------------------------------------------
    const policy = await this.settings.get();

    // `enabled` false, `provider` null (nobody has chosen one) and `provider`
    // naming a vendor this build has never heard of (a rollback across the
    // addition of a provider) are ONE outcome here, deliberately. All three are
    // ordinary states of a deployment nobody has finished setting up, all three
    // are an administrator's business rather than the document owner's, and
    // there is nothing a reader of this row could do differently between them.
    // `AiConfigService.getConfig` collapses the same three for the same reason.
    const provider = policy.enabled && policy.provider ? this.providers.get(policy.provider) : undefined;

    if (!provider) {
      await this.skip(documentType, documentId, ownerId, SEARCH_REASON_NOT_CONFIGURED);

      return;
    }

    // ⚠ ASKED, NOT ASSUMED. `embedding` + `embed` are optional and declared as
    // a pair (`ai-provider.interface.ts`'s EMBEDDINGS section): a vendor with
    // no embeddings endpoint, or an OpenAI-compatible gateway proxying only
    // `/chat/completions`, is a perfectly registrable CHAT provider whose notes
    // generate exactly as before. Its deployment simply has no semantic search,
    // which is a fact worth recording per document rather than a crash inside a
    // queue job.
    const capability = provider.embedding;

    if (!capability || typeof provider.embed !== 'function') {
      await this.skip(documentType, documentId, ownerId, SEARCH_REASON_EMBEDDING_UNSUPPORTED);

      return;
    }

    const settingsParse = provider.settingsSchema.safeParse(
      (policy.providers as Record<string, unknown>)[provider.id] ?? {},
    );

    if (!settingsParse.success) {
      // The deployment's own configuration block for this provider is invalid,
      // which is the same kind of fact as "no provider is chosen" and has the
      // same fix and the same person to talk to.
      await this.skip(documentType, documentId, ownerId, SEARCH_REASON_NOT_CONFIGURED);

      return;
    }

    // ⚠ THE OWNER'S KEY, NOT THE CALLER'S. There is no caller: this job runs
    // unattended, minutes or hours after whoever edited the document has gone.
    // Content is embedded ONCE, by the account of the person who owns it, which
    // is the only attribution that stays true no matter who later reads or
    // searches it.
    const apiKey = await this.credentials.getSecret(ownerId, provider.id);

    if (!apiKey) {
      await this.skip(documentType, documentId, ownerId, SEARCH_REASON_KEY_MISSING);

      return;
    }

    // -------------------------------------------------------------------------
    // 3. Chunk, and ask the one question that makes an unedited document free.
    // -------------------------------------------------------------------------
    const document = await this.loadDocument(documentType, documentId);

    if (!document) {
      await this.index.forget(documentType, documentId);

      return;
    }

    const fingerprint = fingerprintDocument(document.chunks);

    const state = await this.prisma.searchIndexState.findUnique({
      where: { documentType_documentId: { documentType, documentId } },
      select: { status: true, contentFingerprint: true, model: true },
    });

    // ⚠ THE MODEL IS PART OF THE COMPARISON, AND LEAVING IT OUT WOULD BE SILENT.
    // The fingerprint is a hash of the TEXT and says nothing about which model
    // embedded it; two models' vectors are not comparable at any width (see
    // `AiEmbeddingCapability.model`). A document indexed under an earlier model
    // has an unchanged fingerprint and unusable vectors, so it must fall
    // through — and then it costs nothing extra to handle, because the chunk
    // rows all match by hash and the "no `search_embeddings` row for (chunk,
    // model)" query below selects every one of them for free.
    if (
      state?.status === 'indexed' &&
      state.contentFingerprint === fingerprint &&
      state.model === capability.model
    ) {
      // NOTHING TO DO — and this is the branch the whole design is for. One
      // string comparison answers "is any of this stale?" without loading,
      // comparing or re-embedding a single chunk. `indexed_at` is still moved,
      // because it means "this row was confirmed current at", which is exactly
      // what just happened.
      await this.prisma.searchIndexState.update({
        where: { documentType_documentId: { documentType, documentId } },
        data: { indexedAt: new Date() },
      });

      this.logger.log(
        `${documentType} ${documentId} is unchanged since its last index; nothing to embed`,
      );

      return;
    }

    // -------------------------------------------------------------------------
    // 4. Reconcile, embed, settle.
    // -------------------------------------------------------------------------
    await this.markIndexing(documentType, documentId, ownerId);

    try {
      const chunkRows = await this.reconcileChunks(documentType, documentId, document.chunks);

      const embedded = await this.embedMissing({
        documentType,
        documentId,
        ownerId,
        provider,
        capability,
        apiKey,
        settings: settingsParse.data,
        chunkIds: chunkRows,
      });

      await this.prisma.searchIndexState.update({
        where: { documentType_documentId: { documentType, documentId } },
        data: {
          status: 'indexed',
          reason: null,
          lastError: null,
          chunkCount: document.chunks.length,
          model: capability.model,
          contentFingerprint: fingerprint,
          indexedAt: new Date(),
        },
      });

      this.logger.log(
        `Indexed ${documentType} ${documentId}: ${document.chunks.length} chunk(s), ` +
          `${embedded} embedded, ${document.chunks.length - embedded} reused`,
      );
    } catch (error) {
      // A 429 IS NOT A FAILURE. Straight back to the queue, which defers this
      // job against the per-user bucket registered in `embedMissing` without
      // charging an attempt. Nothing is written to `search_index_state`: the
      // document is still mid-index and saying otherwise would be a lie with a
      // timestamp on it.
      if (error instanceof RateLimitError) throw error;

      // The provider refused the owner's key. A FACT ABOUT THAT ACCOUNT, not
      // about this deployment and not a bug — a key was revoked, rotated, or
      // ran out of credit — so it is recorded and the job returns. Retrying
      // would re-ask a question whose answer cannot change until the owner does
      // something, and the thing they must do is visible only from this row.
      if (error instanceof AiAuthError) {
        await this.settle(documentType, documentId, ownerId, {
          status: 'skipped',
          reason: SEARCH_REASON_KEY_INVALID,
        });

        return;
      }

      // Everything else — including `dimension_mismatch`, which `embedMissing`
      // has already recorded as `failed` — is rethrown so `Job.lastError`
      // carries what actually happened and the attempt budget above applies.
      await this.recordError(documentType, documentId, ownerId, error);

      throw error;
    }

    // -------------------------------------------------------------------------
    // 5. Did the document move underneath us?
    // -------------------------------------------------------------------------
    //
    // ⚠ THE DEDUP RACE, CLOSED HERE BECAUSE IT CANNOT BE CLOSED AT THE ENQUEUE.
    // A `search.index` job dedups against any earlier one still `pending` or
    // `running`, which is right for a burst of corrections and wrong for the
    // one edit that lands WHILE this job is running: that enqueue is collapsed
    // onto this job, which read the older text minutes ago, and the edit would
    // be indexed never — with no error, no failed row and nothing in the admin
    // job list to look at. The exact shape of `transcription.poll`'s trap.
    //
    // So: re-read the one token that says whether the chunker's input moved,
    // and queue a follow-up with `skipDedup: true` when it did. The flag is not
    // an optimisation — without it the enqueue matches THIS STILL-RUNNING JOB's
    // dedup key and silently returns it, which is the bug rather than the fix.
    const current = await this.readRevision(documentType, documentId);

    if (current !== null && current !== document.revision) {
      this.logger.log(
        `${documentType} ${documentId} changed while it was being indexed; queueing a follow-up`,
      );

      await this.index.enqueue(documentType, documentId, 'rerun', { skipDedup: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  /** The owner id alone, for the gates. See `process` step 1. */
  private async loadOwner(
    documentType: SearchDocumentType,
    documentId: string,
  ): Promise<string | null> {
    if (documentType === SEARCH_DOC_TRANSCRIPT) {
      const row = await this.prisma.transcript.findFirst({
        // ⚠ `deletedAt: null`. A soft-deleted document is one whose owner has
        // asked for it to be destroyed and whose `transcript.purge` is already
        // queued; indexing it would spend their money embedding text that is
        // about to be deleted, and would race the purge's own `forget`.
        where: { id: documentId, deletedAt: null },
        select: { ownerId: true },
      });

      return row?.ownerId ?? null;
    }

    const row = await this.prisma.note.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { ownerId: true },
    });

    return row?.ownerId ?? null;
  }

  /**
   * The document's content, chunked, plus the revision token step 5 compares
   * against.
   *
   * ⚠ `revision` IS NOT `updatedAt`, AND THE DIFFERENCE MATTERS IN BOTH
   * DIRECTIONS. `transcripts.updated_at` is rewritten by every pipeline
   * transition — a transcode finishing, a playback status moving — none of
   * which changes one character the chunker reads, so comparing it would queue
   * a pointless follow-up job after most index runs. Conversely
   * `notes.current_version` alone is not enough, because a note RENAME writes
   * no version and the title is prefixed onto every one of its chunks.
   *
   * So each token is built from exactly what feeds the chunker, which is also
   * the shortest honest statement of what that is:
   *
   *   • a transcript — its version. Segment text, segment order and speaker
   *     display names all move only through an op batch, which is a version.
   *     Its TITLE is deliberately absent: `chunkTranscript` never sees it.
   *   • a note — its version AND its title, because `noteChunkPrefix(title)`
   *     is part of every chunk's embedded text.
   */
  private async loadDocument(
    documentType: SearchDocumentType,
    documentId: string,
  ): Promise<LoadedDocument | null> {
    if (documentType === SEARCH_DOC_TRANSCRIPT) {
      const transcript = await this.prisma.transcript.findFirst({
        where: { id: documentId, deletedAt: null },
        select: {
          ownerId: true,
          currentVersion: true,
          segments: {
            orderBy: { ordinal: 'asc' },
            select: {
              ordinal: true,
              text: true,
              speaker: { select: { displayName: true } },
            },
          },
        },
      });

      if (!transcript) return null;

      return {
        ownerId: transcript.ownerId,
        // ⚠ `displayName`, NOT `label`. `label` is the provider's own
        // diarization letter (`"A"`), an identifier; `displayName` is what a
        // reader sees and what a user renames ("Alice"). The chunker prefixes
        // the label a HUMAN would read onto each line, and `content_hash`
        // covers it — so reattributing a line from `Speaker A` to `Alice`
        // correctly reads as an edit, because the text the model embeds did
        // change even though the words did not.
        chunks: chunkTranscript(
          transcript.segments.map((segment) => ({
            ordinal: segment.ordinal,
            text: segment.text,
            speakerLabel: segment.speaker?.displayName ?? null,
          })),
        ),
        revision: `v${transcript.currentVersion}`,
      };
    }

    const note = await this.prisma.note.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { ownerId: true, currentVersion: true, title: true, body: true },
    });

    if (!note) return null;

    return {
      ownerId: note.ownerId,
      chunks: chunkNote(note.title, note.body),
      revision: `v${note.currentVersion}:${note.title}`,
    };
  }

  /** Re-reads just the revision token. See `loadDocument`. */
  private async readRevision(
    documentType: SearchDocumentType,
    documentId: string,
  ): Promise<string | null> {
    if (documentType === SEARCH_DOC_TRANSCRIPT) {
      const row = await this.prisma.transcript.findFirst({
        where: { id: documentId, deletedAt: null },
        select: { currentVersion: true },
      });

      return row ? `v${row.currentVersion}` : null;
    }

    const row = await this.prisma.note.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { currentVersion: true, title: true },
    });

    return row ? `v${row.currentVersion}:${row.title}` : null;
  }

  // ---------------------------------------------------------------------------
  // Chunk reconciliation
  // ---------------------------------------------------------------------------

  /**
   * Bring `search_chunks` into line with the freshly-computed chunks, and
   * return every chunk row's id in ordinal order.
   *
   * ⚠ THE OBVIOUS IMPLEMENTATION — delete this document's chunks and insert the
   * new ones — WOULD DESTROY THE ENTIRE ECONOMIC ARGUMENT FOR THIS EPIC. Every
   * new chunk row would have a new id, no `search_embeddings` row would match
   * any of them, and every edit to any document would re-embed all of it on the
   * owner's own account. The upsert on `(document_type, document_id, ordinal)`
   * is what keeps a chunk's IDENTITY stable across an edit so its vector
   * survives.
   *
   * ⚠ AND THE PRICE OF THAT STABILITY IS THE `deleteMany` IN THE `else` BRANCH.
   * Because the row's id survives an update, so do its vectors — which were
   * computed from the OLD text. Nothing cascades, because nothing was deleted.
   * A chunk whose `content_hash` moved must therefore have its embeddings
   * dropped EXPLICITLY, or the document keeps a vector describing text it no
   * longer contains: a search hit that returns confidently wrong passages, with
   * no error anywhere and no way to notice from the outside. This is the single
   * most dangerous line in the file.
   */
  private async reconcileChunks(
    documentType: SearchDocumentType,
    documentId: string,
    chunks: readonly Chunk[],
  ): Promise<string[]> {
    const existing = await this.prisma.searchChunk.findMany({
      where: { documentType, documentId },
      select: { id: true, ordinal: true, contentHash: true },
    });

    const byOrdinal = new Map(existing.map((row) => [row.ordinal, row]));
    const ids: string[] = [];

    for (const chunk of chunks) {
      const previous = byOrdinal.get(chunk.ordinal);

      if (!previous) {
        const created = await this.prisma.searchChunk.create({
          data: {
            documentType,
            documentId,
            ordinal: chunk.ordinal,
            text: chunk.text,
            contentHash: chunk.contentHash,
            charStart: chunk.charStart,
            charEnd: chunk.charEnd,
          },
          select: { id: true },
        });

        ids.push(created.id);

        continue;
      }

      ids.push(previous.id);

      // UNCHANGED TEXT KEEPS ITS VECTOR AND COSTS THE OWNER NOTHING. This is
      // the branch content addressing exists for: a two-word correction in a
      // three-hour transcript re-embeds the one or two chunks it touched, not
      // the hundred it did not.
      if (previous.contentHash === chunk.contentHash) continue;

      await this.prisma.searchChunk.update({
        where: { id: previous.id },
        data: {
          text: chunk.text,
          contentHash: chunk.contentHash,
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
        },
      });

      // See the method header — the one line without which an edited chunk
      // silently keeps its old vector.
      await this.prisma.searchEmbedding.deleteMany({ where: { chunkId: previous.id } });
    }

    // Chunks past the new end: the document got shorter. `ordinal` is dense and
    // 0-based (`packChunks`), so "beyond the new count" is exactly this.
    const removed = await this.prisma.searchChunk.deleteMany({
      where: { documentType, documentId, ordinal: { gte: chunks.length } },
    });

    if (removed.count > 0) {
      this.logger.debug(
        `${documentType} ${documentId} shrank; removed ${removed.count} trailing chunk(s)`,
      );
    }

    return ids;
  }

  // ---------------------------------------------------------------------------
  // Embedding
  // ---------------------------------------------------------------------------

  /**
   * Embed exactly the chunks that have no vector for the active model, in
   * batches the provider has declared it will accept.
   *
   * Returns how many chunks were embedded — the number that cost the owner
   * money, and the one worth logging beside the number that did not.
   */
  private async embedMissing(input: {
    documentType: SearchDocumentType;
    documentId: string;
    ownerId: string;
    provider: AiProvider;
    capability: AiEmbeddingCapability;
    apiKey: string;
    settings: unknown;
    chunkIds: readonly string[];
  }): Promise<number> {
    const { documentType, documentId, ownerId, provider, capability } = input;

    // ⚠ THE WHOLE POINT, EXPRESSED AS ONE `none` FILTER: a chunk with a vector
    // for THIS model is not embedded again, whether it was written by this run,
    // by last week's run, or by an attempt that died half way through this one.
    // `UNIQUE (chunk_id, model)` is what makes this an indexed lookup rather
    // than a scan (the pgvector migration's point 6), and it is also what makes
    // a retry after a partial failure cheap — the 300 chunks the previous
    // attempt committed simply do not come back.
    const pending = await this.prisma.searchChunk.findMany({
      where: {
        documentType,
        documentId,
        embeddings: { none: { model: capability.model } },
      },
      orderBy: { ordinal: 'asc' },
      select: { id: true, text: true },
    });

    if (pending.length === 0) return 0;

    // ⚠ REGISTERED IMMEDIATELY BEFORE THE FIRST CALL, NOT AT `onModuleInit`.
    // See the file header: the bucket is the USER, and a user is not known
    // until a job is running. `ProviderThrottleService` maps job type → key, so
    // registering here is what makes a per-user key expressible at all.
    this.throttle.registerProviderKey(this.type, aiProviderThrottleKey(ownerId));

    const ctx = createProviderContext(input.apiKey, input.settings);
    const embed = provider.embed!.bind(provider);

    let embedded = 0;

    for (let offset = 0; offset < pending.length; offset += capability.maxBatchSize) {
      const batch = pending.slice(offset, offset + capability.maxBatchSize);

      const result = await embed(ctx, { inputs: batch.map((chunk) => chunk.text) });

      if (result.vectors.length !== batch.length) {
        // The provider contract says one vector per input in input order and
        // that the implementation must MAKE that true. A count mismatch reaching
        // here means it did not, and pairing what arrived with the inputs by
        // position would attach vectors to the wrong chunks — the one failure
        // mode nothing downstream can detect.
        throw new Error(
          `Provider "${provider.id}" returned ${result.vectors.length} vector(s) for a ` +
            `${batch.length}-input batch while indexing ${documentType} ${documentId}.`,
        );
      }

      for (const vector of result.vectors) {
        if (vector.length !== EMBEDDING_DIMENSIONS) {
          // A BUG, NOT A USER-STATE FACT — recorded as `failed` and then thrown
          // from `process`. See `SEARCH_REASON_DIMENSION_MISMATCH`.
          await this.settle(documentType, documentId, ownerId, {
            status: 'failed',
            reason: SEARCH_REASON_DIMENSION_MISMATCH,
          });

          throw new Error(
            `Provider "${provider.id}" returned a ${vector.length}-dimension vector while ` +
              `indexing ${documentType} ${documentId}; this application stores vectors of ` +
              `exactly ${EMBEDDING_DIMENSIONS} components and can store nothing else.`,
          );
        }
      }

      await this.writeVectors(batch, result.vectors, capability.model);

      embedded += batch.length;
    }

    // Provenance for the settings page, fire-and-forget by contract. Recorded
    // once per job rather than once per batch: it is a timestamp, not a counter.
    await this.credentials.markUsed(ownerId, provider.id);

    return embedded;
  }

  /**
   * Write one batch's vectors.
   *
   * ⚠ RAW SQL, AND THAT IS INTENDED RATHER THAN A WORKAROUND.
   * `search_embeddings.embedding` is `Unsupported("vector(1536)")` and
   * REQUIRED, so the generated Prisma client emits no `create` for this model
   * at all — there is no TypeScript representation of a pgvector value it could
   * accept. The `SearchEmbedding` model comment in schema.prisma states this
   * explicitly: every write to this table MUST go through `$queryRaw` /
   * `$executeRaw` with the vector literal assembled by hand. Nothing here is
   * routing around a limitation; a `vector` literal has to be built as SQL
   * whatever the client layer offers.
   *
   * ⚠ ONE TRANSACTION PER BATCH, NEVER ONE PER JOB. A batch is the unit that
   * either happened or did not; committing per batch is what makes an attempt
   * that embedded 300 of 400 chunks leave those 300 behind for the retry — the
   * third of the three arguments in the file header for `maxAttempts: 3`.
   * Wrapping the whole job would make every failure cost the owner the entire
   * document again.
   *
   * `ON CONFLICT (chunk_id, model)` because the queue is at-least-once: a job
   * re-run after a lost lease may re-embed a batch whose rows already exist,
   * and the deterministic vector it computed is the same one.
   */
  private async writeVectors(
    batch: readonly { id: string }[],
    vectors: readonly number[][],
    model: string,
  ): Promise<void> {
    const statements = batch.map((chunk, position) => {
      // `[0.1,0.2,…]` — pgvector's own text input format, handed over as an
      // ordinary bound (text) parameter and cast at the statement. The values
      // came through the width check above and the provider's own finite-number
      // check before that, so nothing here is interpolated unchecked.
      const literal = `[${vectors[position]!.join(',')}]`;

      return this.prisma.$executeRaw`
        INSERT INTO search_embeddings (id, chunk_id, model, dimensions, embedding, created_at)
        VALUES (
          ${randomUUID()}::uuid,
          ${chunk.id}::uuid,
          ${model},
          ${EMBEDDING_DIMENSIONS},
          ${literal}::vector,
          now()
        )
        ON CONFLICT (chunk_id, model)
        DO UPDATE SET embedding = EXCLUDED.embedding, dimensions = EXCLUDED.dimensions
      `;
    });

    await this.prisma.$transaction(statements);
  }

  // ---------------------------------------------------------------------------
  // `search_index_state`
  // ---------------------------------------------------------------------------

  /**
   * Record a permanent, non-failure outcome and let the job return normally.
   *
   * ⚠ `chunk_count`, `model` AND `content_fingerprint` ARE CLEARED. A skip
   * means this document is not searchable, and leaving the numbers from a
   * previous successful run would make the row read as "indexed under an older
   * model" — a state the fingerprint short-circuit in `process` would then act
   * on. The chunks and vectors themselves are deliberately NOT deleted: a key
   * that lapses for a week should not cost its owner a full re-embed when they
   * paste a new one.
   */
  private async skip(
    documentType: SearchDocumentType,
    documentId: string,
    ownerId: string,
    reason: string,
  ): Promise<void> {
    await this.settle(documentType, documentId, ownerId, { status: 'skipped', reason });

    this.logger.log(
      `${documentType} ${documentId} is not semantically searchable: ${reason}`,
    );
  }

  private async settle(
    documentType: SearchDocumentType,
    documentId: string,
    ownerId: string,
    settlement: Settlement,
  ): Promise<void> {
    await this.prisma.searchIndexState.upsert({
      where: { documentType_documentId: { documentType, documentId } },
      create: {
        documentType,
        documentId,
        ownerId,
        status: settlement.status,
        reason: settlement.reason,
      },
      update: {
        status: settlement.status,
        reason: settlement.reason,
        lastError: null,
        chunkCount: 0,
        model: null,
        contentFingerprint: null,
        indexedAt: null,
      },
    });
  }

  /** `status: 'indexing'`, so a run in flight (or one that died) is legible. */
  private async markIndexing(
    documentType: SearchDocumentType,
    documentId: string,
    ownerId: string,
  ): Promise<void> {
    await this.prisma.searchIndexState.upsert({
      where: { documentType_documentId: { documentType, documentId } },
      create: { documentType, documentId, ownerId, status: 'indexing' },
      // ⚠ `contentFingerprint` IS NOT CLEARED HERE, unlike in `settle`. It is
      // still true of the chunks currently in the table, and clearing it would
      // turn a crashed attempt into a guaranteed full re-embed of a document
      // whose chunks are mostly still valid.
      update: { status: 'indexing', reason: null, lastError: null, ownerId },
    });
  }

  /** Record an unrecognised failure. The job then rethrows; see `process`. */
  private async recordError(
    documentType: SearchDocumentType,
    documentId: string,
    ownerId: string,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    await this.prisma.searchIndexState.upsert({
      where: { documentType_documentId: { documentType, documentId } },
      create: {
        documentType,
        documentId,
        ownerId,
        status: 'failed',
        lastError: message.slice(0, 2000),
      },
      // ⚠ `reason` IS DELIBERATELY NOT TOUCHED, and `dimension_mismatch` is
      // why: `embedMissing` has already settled that case with its own reason,
      // and overwriting it with `null` would discard the one word that says
      // what went wrong. The status is forced, because a row left saying
      // `indexing` after the run ended is the one state an operator reading
      // this table cannot interpret — it is indistinguishable from a run still
      // in flight. A retry moves it back to `indexing` itself.
      update: { status: 'failed', lastError: message.slice(0, 2000) },
    });
  }
}

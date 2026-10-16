import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type { SearchIndexStatus } from '@prisma/client';

import { AiProviderRegistry } from '../../ai/ai-provider.registry';
import { AiSettingsService } from '../../ai/ai-settings.service';
import { UserAiCredentialsService } from '../../ai/user-ai-credentials.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SEARCH_DOC_TRANSCRIPT,
  SEARCH_DOCUMENT_TYPES,
  SEARCH_REASON_EMBEDDING_UNSUPPORTED,
  SEARCH_REASON_KEY_MISSING,
  SEARCH_REASON_NOT_CONFIGURED,
  type SearchDocumentType,
} from './job-types';
import { SearchIndexService } from './search-index.service';
import {
  SEARCH_INDEX_FAILURE_LIMIT,
  SEARCH_INDEX_REQUEST_CAP,
  type SearchIndexRequestResult,
  type SearchIndexStatusResponse,
} from './dto/search-index-status.dto';

// =============================================================================
// SearchIndexStatusService (issue #191, epic #165) — what of YOUR library is
// semantically searchable, and the one button that changes the answer
// =============================================================================
//
// Indexing spends the DOCUMENT OWNER'S OWN vendor key, so this epic has no
// backfill cron and never will (`job-types.ts`'s header is the whole argument).
// That makes indexing an existing library an EXPLICIT ACTION — and an explicit
// action with nowhere to take it is not a design decision, it is a missing
// feature: `semantic: false` would be an invisible degradation and the epic
// would read as broken. This service is the two answers that page needs.
//
// -----------------------------------------------------------------------------
// WHY EVERYTHING HERE IS OWNED, NOT SHARED
// -----------------------------------------------------------------------------
//
// `TranscriptAccessService` lets somebody read a recording that was shared with
// them, and `GET /api/search` searches those shares. None of them are counted
// here and none of them can be queued from here.
//
// A SHARE LETS YOU READ SOMEBODY ELSE'S RECORDING. IT DOES NOT MAKE THEIR
// INDEXING BILL YOURS. `SearchIndexHandler` resolves the key from the
// document's `ownerId` — never from whoever queued the job — so a button that
// offered to index a share would be spending a third party's money on work they
// did not ask for, and the number beside it would be a count of documents this
// caller cannot affect. The owner's own page already offers exactly this action
// for exactly those documents.
//
// -----------------------------------------------------------------------------
// ONE READ PRIMITIVE, TWO CALLERS — AND WHY IT LOADS ROWS RATHER THAN COUNTING
// -----------------------------------------------------------------------------
//
// `loadLibrary` reads two narrow projections per document type (the visible
// documents' `{ id, title, updatedAt }`, and this owner's `search_index_state`
// rows) and joins them in memory. Both `status` and `requestIndex` are built on
// it, which is what makes "the count said 40 unindexed" and "the button queued
// 40" the same computation rather than two that can disagree.
//
// ⚠ THE OBVIOUS ALTERNATIVE — `count()` PLUS A `groupBy` ON status — IS NOT
// EXACT, and the inexactness lands on the number that matters. `search_index_
// state` has no foreign key to `transcripts`/`notes` (the polymorphic reference
// this epic inherits from `Job.subjectType`), so a `groupBy` cannot exclude the
// rows of a document that has been soft-deleted and is awaiting purge. Those
// rows would be counted as `indexed` while their document is absent from
// `total`, and `unindexed = total - sum` would then under-report — silently
// hiding documents from the very button meant to reach them. Joining in memory
// simply never matches those rows, which is the correct answer rather than an
// approximation of it.
//
// The cost is bounded by the caller's own library: a few hundred bytes per
// document, for one request on one settings page. A library large enough for
// that to be uncomfortable is a library where `SEARCH_INDEX_REQUEST_CAP` is
// already the binding constraint, and the honest fix then is a paged surface —
// not a cheaper count that lies.
// =============================================================================

/**
 * Skip reasons that are facts about the ACCOUNT or the DEPLOYMENT, not about a
 * document — so they are reported once, by `reason`, and never as per-document
 * failure rows.
 *
 * A deployment that switches AI off writes `ai_not_configured` onto every
 * document its users touch. Listing four hundred of those would turn one
 * sentence ("your administrator has not set up AI") into four hundred rows
 * saying it, and would bury the one row that says something else.
 *
 * ⚠ IT IS A LIST OF WHAT TO ELIDE, NOT A LIST OF WHAT TO SHOW. `reason` is a
 * plain text column that grows new values (see its own comment in the schema),
 * so an unrecognised reason is SURFACED rather than hidden: the failure this
 * page exists for is the one nobody has seen before.
 */
const ACCOUNT_WIDE_SKIP_REASONS: readonly string[] = [
  SEARCH_REASON_KEY_MISSING,
  SEARCH_REASON_NOT_CONFIGURED,
  SEARCH_REASON_EMBEDDING_UNSUPPORTED,
];

/** One owned document, with whatever the index knows about it. */
interface LibraryEntry {
  id: string;
  title: string;
  /** The document's own `updatedAt` — the cheap "might have moved" signal. */
  updatedAt: Date;
  state: {
    status: SearchIndexStatus;
    reason: string | null;
    lastError: string | null;
    model: string | null;
    indexedAt: Date | null;
    updatedAt: Date;
  } | null;
}

/** What this deployment can embed with, if anything. */
interface EmbeddingCapabilityView {
  available: boolean;
  model: string | null;
  /** Set only when `available` is false. */
  reason: string | null;
  /**
   * The vendor a key would belong to — resolved INDEPENDENTLY of the master
   * switch, and `null` only when there is genuinely no vendor to name.
   *
   * ⚠ This is issue #83's lesson, imported wholesale. `AiConfigService` used to
   * blank the provider whenever AI was switched off, which meant the key form
   * could not say which vendor it was collecting a key FOR, which meant nobody
   * could put a key in place before an administrator finished the setup that
   * needed one. A field that names a vendor must not also mean "you are allowed
   * to proceed". Here it decides one thing only: which provider's row in
   * `user_ai_credentials` `hasKey` looks at.
   */
  providerId: string | null;
}

@Injectable()
export class SearchIndexStatusService {
  private readonly logger = new Logger(SearchIndexStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: AiProviderRegistry,
    private readonly settings: AiSettingsService,
    private readonly credentials: UserAiCredentialsService,
    // ⚠ THE SAME `SearchIndexService` THE PIPELINE ENQUEUES THROUGH. There is
    // deliberately no second enqueue path: priority, dedup and the payload
    // shape are decided in one place, so a job queued by this button is
    // indistinguishable from one queued by a correction.
    private readonly index: SearchIndexService,
  ) {}

  // ---------------------------------------------------------------------------
  // GET /api/search/index-status
  // ---------------------------------------------------------------------------

  /**
   * What is and is not semantically searchable, for one caller's own library.
   *
   * NEVER THROWS FOR AN UNCONFIGURED DEPLOYMENT, the same contract
   * `AiConfigService.getConfig` states: "nobody has set this up" is the normal
   * state of a fresh installation and is reported as `available: false` with a
   * `reason`, not as an error. A page asking "can I index?" that gets a 500 has
   * learned nothing it can act on.
   */
  async status(userId: string): Promise<SearchIndexStatusResponse> {
    const capability = await this.resolveCapability();
    const hasKey = await this.callerHasKey(userId, capability.providerId);

    const libraries = await Promise.all(
      SEARCH_DOCUMENT_TYPES.map(async (type) => ({
        type,
        entries: await this.loadLibrary(userId, type),
      })),
    );

    const types = libraries.map(({ type, entries }) => this.countEntries(type, entries));

    const failures = libraries
      .flatMap(({ type, entries }) =>
        entries
          .filter((entry) => this.isReportableFailure(entry))
          .map((entry) => ({
            type,
            id: entry.id,
            title: entry.title,
            reason: entry.state?.reason ?? null,
            lastError: entry.state?.lastError ?? null,
            // Kept only for the sort below; stripped before it goes out.
            at: entry.state?.updatedAt ?? new Date(0),
          })),
      )
      // Newest first ACROSS BOTH TYPES, which is why the sort happens after the
      // flat map rather than inside each: a user whose notes started failing an
      // hour ago should not have to scroll past last month's transcripts.
      .sort((left, right) => right.at.getTime() - left.at.getTime())
      .slice(0, SEARCH_INDEX_FAILURE_LIMIT)
      .map(({ at: _at, ...failure }) => failure);

    return {
      types,
      model: capability.model,
      // ⚠ RESOLVED INDEPENDENTLY OF `available`, the distinction
      // `ai-config.service.ts` had to learn the hard way (#83): "your
      // administrator has not switched this on" and "you have not pasted a key"
      // are different sentences, with different fixes and different people to
      // talk to. A single fused boolean cannot say either of them.
      hasKey,
      available: capability.available,
      reason: capability.available
        ? hasKey
          ? null
          : SEARCH_REASON_KEY_MISSING
        : capability.reason,
      failures,
    };
  }

  // ---------------------------------------------------------------------------
  // POST /api/search/index
  // ---------------------------------------------------------------------------

  /**
   * Queue indexing for this caller's own documents that need it.
   *
   * ⚠ THE 409s COME FIRST, BEFORE ANY LIBRARY READ. A deployment with no
   * embedding provider, or a caller with no key, would produce jobs that are
   * CERTAIN to write a `skipped` row and return — hundreds of them, each one a
   * row in the admin job list, none of them able to index anything. Refusing is
   * not defensiveness: it is the difference between "this cannot work yet, here
   * is why" and a progress bar that fills up and leaves the library exactly as
   * it was. The same posture, and the same two `details.reason` strings,
   * `POST /api/notes` already takes before it creates a note it could not
   * generate.
   */
  async requestIndex(userId: string): Promise<SearchIndexRequestResult> {
    const capability = await this.resolveCapability();

    if (!capability.available) {
      throw new ConflictException({
        message:
          capability.reason === SEARCH_REASON_EMBEDDING_UNSUPPORTED
            ? 'The AI provider this deployment is configured for does not offer embeddings, so ' +
              'nothing can be indexed for semantic search. Your administrator can change the ' +
              'provider in the system AI settings.'
            : 'This deployment has no AI provider configured, so nothing can be indexed for ' +
              'semantic search. Your administrator sets this up in the system AI settings.',
        // ⚠ UNDER `details`, NOT AS A TOP-LEVEL `code`: the global
        // `HttpExceptionFilter` derives `code` from the STATUS and overwrites
        // whatever an exception supplied, so a machine-readable reason belongs
        // exactly where that filter says endpoint-specific data belongs. Same
        // placement, and the same strings, as `POST /api/notes`.
        details: { reason: capability.reason ?? SEARCH_REASON_NOT_CONFIGURED },
      });
    }

    if (!(await this.callerHasKey(userId, capability.providerId))) {
      throw new ConflictException({
        message:
          'You have not saved an AI provider key. This deployment holds no key of its own — ' +
          'every key belongs to an individual user — so indexing your library authenticates as ' +
          'you and is billed to your own provider account. Add your key on your AI settings ' +
          'page and try again.',
        details: { reason: SEARCH_REASON_KEY_MISSING },
      });
    }

    const candidates: Array<{ type: SearchDocumentType; id: string; updatedAt: Date }> = [];

    for (const type of SEARCH_DOCUMENT_TYPES) {
      const entries = await this.loadLibrary(userId, type);

      for (const entry of entries) {
        if (this.needsIndexing(entry, capability.model)) {
          candidates.push({ type, id: entry.id, updatedAt: entry.updatedAt });
        }
      }
    }

    // Newest first. If the cap bites, the documents a user is most likely to
    // search for are the ones they touched most recently — and the leftovers
    // are reported rather than dropped, so the next press takes the next 200.
    candidates.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());

    const selected = candidates.slice(0, SEARCH_INDEX_REQUEST_CAP);

    for (const candidate of selected) {
      // `reason: 'backfill'` — the enum member that exists for exactly this: a
      // person asking for work that was never queued at the time, as distinct
      // from `upload` (content just arrived) and `rerun` (an earlier attempt is
      // being repeated).
      //
      // ⚠ DEDUP LEFT ON. A second press while the first batch is still draining
      // matches the earlier `pending`/`running` job for the same subject and
      // adds nothing, which is exactly right: this button is idempotent by
      // construction rather than by a guard somebody has to remember.
      await this.index.enqueue(candidate.type, candidate.id, 'backfill');
    }

    if (selected.length > 0) {
      this.logger.log(
        `Queued ${selected.length} document(s) for semantic indexing on behalf of ${userId}` +
          (candidates.length > selected.length
            ? ` (${candidates.length - selected.length} left for a later request)`
            : ''),
      );
    }

    return {
      queued: selected.length,
      remaining: candidates.length - selected.length,
      cap: SEARCH_INDEX_REQUEST_CAP,
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Can this deployment embed anything at all, and with which model?
   *
   * THE SAME FOUR FACTS `SearchIndexHandler` checks before it embeds, in the
   * same order, so the page's "unavailable, because…" is the reason the job
   * would have written onto every document. It is deliberately NOT
   * `AiConfigService.getConfig().available`: that boolean additionally requires
   * a permitted CHAT model whose token budget resolves, which has nothing to do
   * with embeddings — a deployment with an empty `allowedModels` can index
   * perfectly well, and reporting it as unavailable here would disable a button
   * that works.
   */
  private async resolveCapability(): Promise<EmbeddingCapabilityView> {
    const policy = await this.settings.get();

    // Resolved before any branch, and without consulting `enabled` — see
    // `providerId`'s own comment for why that independence is load-bearing.
    const named = policy.provider ? this.providers.get(policy.provider) : undefined;
    const providerId = named?.id ?? null;

    const provider = policy.enabled ? named : undefined;

    if (!provider) {
      // Off, nobody chosen, or naming a vendor this build has never heard of
      // (a rollback across the addition of a provider). One outcome
      // deliberately: all three are an administrator's business, and there is
      // nothing a reader could do differently between them.
      return {
        available: false,
        model: null,
        reason: SEARCH_REASON_NOT_CONFIGURED,
        providerId,
      };
    }

    const capability = provider.embedding;

    if (!capability || typeof provider.embed !== 'function') {
      // A perfectly good CHAT provider that declares no embeddings — an
      // OpenAI-compatible gateway proxying only `/chat/completions` is the
      // worked example. Notes generate; nothing can be semantically searched.
      return {
        available: false,
        model: null,
        reason: SEARCH_REASON_EMBEDDING_UNSUPPORTED,
        providerId,
      };
    }

    return { available: true, model: capability.model, reason: null, providerId };
  }

  /**
   * Has the CALLER saved a key for the active provider?
   *
   * Read without decrypting anything (`hasKey` selects `{ id: true }`): a path
   * that decrypts a credential to answer a capability question is a path one
   * careless `return` away from publishing it.
   */
  private async callerHasKey(userId: string, providerId: string | null): Promise<boolean> {
    if (!providerId) return false;

    return this.credentials.hasKey(userId, providerId);
  }

  /**
   * Every document of one kind this caller OWNS and can still see, paired with
   * whatever `search_index_state` knows about it.
   *
   * `deletedAt: null` matches `SearchIndexHandler.loadOwner` exactly: a
   * soft-deleted document is one whose owner has asked for it to be destroyed
   * and whose purge is already queued, so it is neither counted nor queued.
   */
  private async loadLibrary(
    userId: string,
    type: SearchDocumentType,
  ): Promise<LibraryEntry[]> {
    const documents =
      type === SEARCH_DOC_TRANSCRIPT
        ? await this.prisma.transcript.findMany({
            where: { ownerId: userId, deletedAt: null },
            select: { id: true, title: true, updatedAt: true },
          })
        : await this.prisma.note.findMany({
            where: { ownerId: userId, deletedAt: null },
            select: { id: true, title: true, updatedAt: true },
          });

    const states = await this.prisma.searchIndexState.findMany({
      // ⚠ `ownerId` IS IN THE QUERY, not applied afterwards. It is the column
      // the `(owner_id, status)` index exists for, and it means a row belonging
      // to another user is never read rather than being read and filtered —
      // the same discipline `UserAiCredentialsService.list` states.
      where: { ownerId: userId, documentType: type },
      select: {
        documentId: true,
        status: true,
        reason: true,
        lastError: true,
        model: true,
        indexedAt: true,
        updatedAt: true,
      },
    });

    const byDocument = new Map(states.map((state) => [state.documentId, state]));

    return documents.map((document) => ({
      id: document.id,
      title: document.title,
      updatedAt: document.updatedAt,
      state: byDocument.get(document.id) ?? null,
    }));
  }

  /** The five per-type numbers, plus the one that has no row behind it. */
  private countEntries(
    type: SearchDocumentType,
    entries: readonly LibraryEntry[],
  ): SearchIndexStatusResponse['types'][number] {
    let indexed = 0;
    let pending = 0;
    let failed = 0;
    let skipped = 0;
    let unindexed = 0;

    for (const entry of entries) {
      switch (entry.state?.status) {
        case 'indexed':
          indexed += 1;
          break;
        // `indexing` and `pending` are ONE number on the wire — see the DTO.
        case 'indexing':
        case 'pending':
          pending += 1;
          break;
        case 'failed':
          failed += 1;
          break;
        case 'skipped':
          skipped += 1;
          break;
        default:
          // No row at all: never queued, so never skipped and never failed.
          // The ordinary state of everything that predates this epic, and what
          // the button acts on.
          unindexed += 1;
      }
    }

    return { type, indexed, pending, failed, skipped, unindexed, total: entries.length };
  }

  /** Is this a failure worth naming a document for? See `ACCOUNT_WIDE_SKIP_REASONS`. */
  private isReportableFailure(entry: LibraryEntry): boolean {
    const state = entry.state;

    if (!state) return false;
    if (state.status === 'failed') return true;
    if (state.status !== 'skipped') return false;

    // A skip whose reason is NOT one of the account-wide ones — `ai_key_invalid`
    // (the provider refused this user's key) is today's example, and anything a
    // later issue adds is tomorrow's. Surfaced per document because it is not
    // already said once above.
    return state.reason !== null && !ACCOUNT_WIDE_SKIP_REASONS.includes(state.reason);
  }

  /**
   * Would indexing this document do anything?
   *
   * ⚠ A DELIBERATE OVER-APPROXIMATION, AND IT OVER-APPROXIMATES IN THE SAFE
   * DIRECTION. The real test for "has this document's content moved" is the
   * content fingerprint, which cannot be computed without loading and chunking
   * the whole document — a megabyte of segment text per transcript, for a
   * question this page asks about the entire library at once. So the cheap
   * signals are used here (no row; a row that did not succeed; a row indexed
   * under a different embedding model; a row older than the document's own
   * `updatedAt`), and the FINGERPRINT REMAINS THE AUTHORITY: the handler
   * compares it and returns immediately when nothing moved.
   *
   * The consequence of being wrong in this direction is an empty job that costs
   * one row read and embeds nothing — no vendor call, no money. The consequence
   * of the opposite would be a document silently left out of the button that
   * exists to reach it, which is the failure this whole page is about.
   *
   * `pending`/`indexing` are NOT candidates: work is already queued, and
   * enqueueing again would be deduplicated anyway.
   */
  private needsIndexing(entry: LibraryEntry, activeModel: string | null): boolean {
    const state = entry.state;

    if (!state) return true;
    if (state.status === 'pending' || state.status === 'indexing') return false;
    if (state.status !== 'indexed') return true;

    if (activeModel !== null && state.model !== activeModel) return true;

    return state.indexedAt === null || state.indexedAt.getTime() < entry.updatedAt.getTime();
  }
}

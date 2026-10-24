// =============================================================================
// `note.import.format` (issue #729, epic #728): formatting what was kept "as is"
// =============================================================================
//
// A document kept as a note (single keep, ad-hoc drop, note library) arrives as the text a
// parser extracted: PDF lines wrapped mid-sentence, no headings, slides run together.
// `note.library.import` commits that text as version 1 and queues this job, which asks the
// owner's model to format it into KVox note Markdown (structure only) and commits the result as
// the NEXT version (`kind: 'edit'`, `authorId: null` = the AI, summary "Formatted with AI").
//
// FAITHFUL OR NOTHING. The model is never trusted: `checkFormattingFaithfulness` compares the
// word multisets, and a result that dropped or invented more than 3% is refused, leaving
// version 1 as imported. A refusal, an unavailable model (no key, AI off, model not
// permitted), a provider error, a note the owner edited in the meantime: none of these is a
// failed job. The note is already good enough to keep; the outcome goes in the log and in the
// `note:import_format` audit row, never the text.
//
// ⚠ A RATE LIMIT IS THE ONE THING THAT RETHROWS: the work has not been done, so the queue
// defers the job (without charging an attempt) on the owner's own bucket and runs it again,
// and nothing is published until it has actually run.
//
// ⚠ `note_ready` IS THIS JOB'S TO PUBLISH (the import handler queued us instead of emitting
// it), so it is emitted in EVERY outcome, after the commit, outside any transaction, and in
// its own try/catch, with the version the note ended at. The graph therefore reads the
// formatted text when there is one, and the imported text when there is not. The search index
// is queued only when this job committed a new version (the import queued it for version 1).
//
// SERVER-ONLY, PERMANENTLY: neither `nodeResultSchema` nor `persistNodeResult` (it spends the
// owner's own key; `usesAi`). `maxAttempts: 1`, `note.generate`'s argument: a retry would call
// the provider again on the user's account for a non-deterministic answer.
//
// THE MODEL AND KEY ARE RESOLVED LIKE `note.generate`: `KVOX_AI.resolveTask` for the owner,
// the deployment's default model (`notes.generate` feature; no per-note model exists for an
// imported note). The key is never loaded here.
// =============================================================================

import { ConflictException, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { aiProviderThrottleKey } from '../../core/index.js';
import {
  KVOX_AI,
  KVOX_AUDIT,
  KVOX_EVENTS,
  KVOX_JOBS,
  KVOX_PRISMA,
  KvoxAiError,
  KvoxRateLimitError,
  type KvoxAiPort,
  type KvoxAiTarget,
  type KvoxAuditPort,
  type KvoxEventsPort,
  type KvoxJob,
  type KvoxJobHandler,
  type KvoxJobProfile,
  type KvoxJobsPort,
} from '../../ports/index.js';
import { SEARCH_DOC_NOTE, SearchIndexService } from '../../search/index.js';
import type { KvoxNotesDb } from '../data/notes-db.js';
import { NOTE_GENERATE_AI_FEATURE } from '../generation/ai-support.js';
import {
  IMPORT_FORMAT_CHUNK_CHARS,
  IMPORT_FORMAT_SYSTEM_PROMPT,
  buildImportFormatUserContent,
  checkFormattingFaithfulness,
  chunkMarkdownForFormatting,
  stripOuterCodeFence,
} from '../generation/import-format.js';
import { NOTE_IMPORT_FORMAT_JOB_TYPE } from '../job-types.js';
import { NoteVersionWriter } from '../note-version-writer.js';
import { NOTE_READY_EVENT, type NoteReadyEvent } from '../notes.events.js';

/**
 * The AI feature a format pass runs under: `notes.generate`, so the model, the key and the
 * usage line are the note feature's own (no separate admin feature to configure).
 *
 * @stability experimental
 */
export const NOTE_IMPORT_FORMAT_AI_FEATURE = NOTE_GENERATE_AI_FEATURE;

/** Ten minutes: a long document is several sequential model calls. */
export const NOTE_IMPORT_FORMAT_MAX_RUNTIME_MS = 10 * 60 * 1000;

/** The version summary the AI's commit carries. */
export const NOTE_IMPORT_FORMAT_SUMMARY = 'Formatted with AI';

/** The audit action of one format pass. */
export const NOTE_IMPORT_FORMAT_AUDIT_ACTION = 'note:import_format';

/** Output budget per input token: Markdown marks add a little to the text. */
const OUTPUT_TOKENS_PER_INPUT_TOKEN = 1.5;

/** Headroom on top of that. */
const OUTPUT_TOKENS_HEADROOM = 256;

/**
 * How a format pass ended. `formatted` is the only outcome that writes a version.
 *
 * @stability experimental
 */
export type NoteImportFormatOutcome =
  | 'formatted'
  | 'stale_version'
  | 'empty'
  | 'ai_unavailable'
  | 'ai_error'
  | 'unfaithful'
  | 'error';

/** What the job carries. */
interface FormatPayload {
  itemId?: string;
  noteId: string;
  version: number;
}

/** The result of the model work. */
interface FormatResult {
  outcome: NoteImportFormatOutcome;
  /** The version committed, when `outcome` is `formatted`. */
  committedVersion?: number;
  reason?: string;
  coverage?: number;
  precision?: number;
  chunks?: number;
}

/**
 * NoteImportFormatHandler: wiring the slice registers itself; a host configures it through
 * `NotesModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class NoteImportFormatHandler implements KvoxJobHandler, OnModuleInit {
  private readonly logger = new Logger(NoteImportFormatHandler.name);

  readonly type = NOTE_IMPORT_FORMAT_JOB_TYPE;

  readonly label = 'Note import formatting';

  /** The handler spends the owner's own provider key, so it can never be offered to a node. */
  readonly usesAi = true;

  readonly profile: KvoxJobProfile = {
    maxRuntimeMs: NOTE_IMPORT_FORMAT_MAX_RUNTIME_MS,
    maxAttempts: 1,
  };

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxNotesDb,
    @Inject(KVOX_JOBS) private readonly jobs: KvoxJobsPort,
    @Inject(KVOX_AI) private readonly ai: KvoxAiPort,
    @Inject(KVOX_AUDIT) private readonly audit: KvoxAuditPort,
    @Inject(KVOX_EVENTS) private readonly events: KvoxEventsPort,
    private readonly versions: NoteVersionWriter,
    private readonly searchIndex: SearchIndexService,
  ) {}

  /** Registers the handler with the job port when the module starts. */
  onModuleInit(): void {
    this.jobs.registerHandler(this);
  }

  async process(job: KvoxJob): Promise<void> {
    const payload = readPayload(job.payload);
    if (!payload) {
      this.logger.warn(`Format job ${job.id} carries no note id and version; nothing to do`);
      return;
    }

    const note = await this.prisma.note.findUnique({ where: { id: payload.noteId } });
    if (!note || note.deletedAt !== null || note.status === 'deleting') {
      this.logger.log(`Note ${payload.noteId} is gone; format job ${job.id} is a no-op`);
      return;
    }

    let result: FormatResult;
    try {
      result = await this.format(note, payload);
    } catch (error) {
      if (error instanceof KvoxRateLimitError) throw error;
      this.logger.warn(`Formatting note ${note.id} failed; it keeps its imported text: ${String(error)}`);
      result = { outcome: 'error', reason: 'internal_error' };
    }

    await this.afterCommit(payload, note.ownerId, note.currentVersion, result);
  }

  // ---------------------------------------------------------------------------

  private async format(
    note: NonNullable<Awaited<ReturnType<KvoxNotesDb['note']['findUnique']>>>,
    payload: FormatPayload,
  ): Promise<FormatResult> {
    // The owner edited (or re-imported) since: their text wins, never overwritten.
    if (note.currentVersion !== payload.version) return { outcome: 'stale_version' };
    if (note.body.trim().length === 0) return { outcome: 'empty' };

    const context = { userId: note.ownerId, orgId: null, feature: NOTE_IMPORT_FORMAT_AI_FEATURE };

    let target: KvoxAiTarget;
    try {
      target = await this.ai.resolveTask(context, NOTE_IMPORT_FORMAT_AI_FEATURE);
    } catch (error) {
      if (!(error instanceof KvoxAiError)) throw error;
      // not_configured, key_missing, capability: nothing to spend, nothing wrong.
      return { outcome: 'ai_unavailable', reason: error.errorClass };
    }

    const chunks = chunkMarkdownForFormatting(note.body, IMPORT_FORMAT_CHUNK_CHARS);
    const formatted: string[] = [];

    for (const chunk of chunks) {
      const user = buildImportFormatUserContent(chunk);
      const inputTokens = this.ai.countTokens(target, user);
      const wanted = Math.ceil(inputTokens * OUTPUT_TOKENS_PER_INPUT_TOKEN) + OUTPUT_TOKENS_HEADROOM;
      let answer = '';

      try {
        for await (const event of this.ai.generateText(context, {
          target,
          system: IMPORT_FORMAT_SYSTEM_PROMPT,
          user,
          maxOutputTokens: target.maxOutputTokens > 0 ? Math.min(wanted, target.maxOutputTokens) : wanted,
        })) {
          if (event.type === 'delta') answer += event.text;
        }
      } catch (error) {
        if (error instanceof KvoxAiError && error.errorClass === 'rate_limit') {
          throw new KvoxRateLimitError(aiProviderThrottleKey(note.ownerId), error.retryAfterMs, error.message);
        }
        if (error instanceof KvoxAiError) return { outcome: 'ai_error', reason: error.errorClass, chunks: chunks.length };
        throw error;
      }

      formatted.push(stripOuterCodeFence(answer, chunk).trim());
    }

    const body = `${formatted.filter((part) => part.length > 0).join('\n\n')}\n`;
    const verdict = checkFormattingFaithfulness(note.body, body);
    if (!verdict.ok) {
      return {
        outcome: 'unfaithful',
        reason: verdict.reason ?? 'unfaithful',
        coverage: verdict.coverage,
        precision: verdict.precision,
        chunks: chunks.length,
      };
    }

    try {
      const updated = await this.versions.commit({
        noteId: note.id,
        baseVersion: payload.version,
        body,
        bodyFormat: 'markdown',
        kind: 'edit',
        authorId: null,
        summary: NOTE_IMPORT_FORMAT_SUMMARY,
        noteStatus: note.status,
      });

      return {
        outcome: 'formatted',
        committedVersion: updated.currentVersion,
        coverage: verdict.coverage,
        precision: verdict.precision,
        chunks: chunks.length,
      };
    } catch (error) {
      if (error instanceof ConflictException) return { outcome: 'stale_version' };
      throw error;
    }
  }

  /** Audit, search index, `note_ready`: each its own try/catch, none can undo the commit. */
  private async afterCommit(
    payload: FormatPayload,
    ownerId: string,
    loadedVersion: number,
    result: FormatResult,
  ): Promise<void> {
    const version = result.committedVersion ?? loadedVersion;
    this.logger.log(
      `Format of note ${payload.noteId} v${payload.version}: ${result.outcome}` +
        `${result.reason ? ` (${result.reason})` : ''}`,
    );

    try {
      await this.audit.record({
        actorUserId: ownerId,
        action: NOTE_IMPORT_FORMAT_AUDIT_ACTION,
        targetType: 'note',
        targetId: payload.noteId,
        meta: {
          itemId: payload.itemId ?? null,
          outcome: result.outcome,
          reason: result.reason ?? null,
          version,
          coverage: result.coverage ?? null,
          precision: result.precision ?? null,
          chunks: result.chunks ?? null,
        },
      });
    } catch (error) {
      this.logger.warn(`Could not audit the format of note ${payload.noteId}: ${String(error)}`);
    }

    if (result.committedVersion !== undefined) {
      try {
        await this.searchIndex.enqueue(SEARCH_DOC_NOTE, payload.noteId);
      } catch (error) {
        this.logger.warn(`Could not queue a search index of formatted note ${payload.noteId}: ${String(error)}`);
      }
    }

    try {
      if (!(await this.autoExtract(payload.itemId))) return;
      this.events.emit(NOTE_READY_EVENT, {
        noteId: payload.noteId,
        ownerId,
        version,
        origin: 'library',
        bulk: true,
      } satisfies NoteReadyEvent);
    } catch (error) {
      this.logger.warn(`Could not publish ${NOTE_READY_EVENT} for note ${payload.noteId}: ${String(error)}`);
    }
  }

  /** The import's rule: a library with `autoExtract` off publishes nothing; ad-hoc imports always do. */
  private async autoExtract(itemId: string | undefined): Promise<boolean> {
    if (!itemId) return true;
    const item = await this.prisma.noteImportBatchItem.findUnique({ where: { id: itemId } });
    const batch = item ? await this.prisma.noteImportBatch.findUnique({ where: { id: item.batchId } }) : null;
    const library = batch?.libraryId ? await this.prisma.noteLibrary.findUnique({ where: { id: batch.libraryId } }) : null;

    return library ? library.autoExtract : true;
  }
}

/** The payload, or `null` when it is not one this handler wrote. Total over garbage. */
function readPayload(payload: unknown): FormatPayload | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  if (typeof raw.noteId !== 'string' || raw.noteId.length === 0) return null;
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) return null;

  return {
    noteId: raw.noteId,
    version: raw.version,
    ...(typeof raw.itemId === 'string' ? { itemId: raw.itemId } : {}),
  };
}

import { Injectable, Logger } from '@nestjs/common';
import { Writable } from 'node:stream';

import { AiInputError } from '../../ai/ai-errors';
import { PrismaService } from '../../prisma/prisma.service';
import { NoteObjectsService } from '../note-objects.service';
import {
  EXTRACTED_OBJECT_ID_KEY,
  readExtractedObjectId,
  readExtractionMetadata,
} from '../source-metadata';
import { buildExportDocument } from '../../transcripts/export/export-document';
import { MarkdownTranscriptExporter } from '../../transcripts/export/markdown.exporter';
import { TranscriptMaterializeService } from '../../transcripts/transcript-materialize.service';

// =============================================================================
// Resolving a note's source text (issue #49, epic #45, docs/specs/notes.md §3.2)
// =============================================================================
//
// `assemblePrompt` never reads a database (see `prompt.ts`). This service is
// what resolves `sourceText` for it, and the three source kinds are three
// genuinely different reads:
//
// -----------------------------------------------------------------------------
// transcript → `TranscriptMaterializeService`, AND NOTHING ELSE
// -----------------------------------------------------------------------------
//
// ⚠ THIS IS THE WHOLE PREMISE OF BUILDING NOTES ON EPIC #19. A transcript's
// `transcript_segments` rows are the CORRECTED state — every speaker rename,
// every fixed word, every merged line the user made — and `materialize()` is
// the canonical "give me the full state at version N" entry point that replays
// the same reducers the live edit path uses. Reading the provider's original
// result object instead, or reconstructing text from some other projection,
// would generate a note from the AI'S FIRST DRAFT of a conversation while the
// user is looking at their own corrected version of it. The note would then
// confidently contain a name the user already fixed. "AI proposes. The user
// controls the truth" is not satisfied by a feature that reads around the
// user's corrections.
//
// The materialized state is rendered to reading text by REUSING THE TRANSCRIPT
// MODULE'S OWN MARKDOWN PROJECTION (`buildExportDocument` + the Markdown
// exporter) rather than writing a third transcript-to-text serializer that
// could disagree with the other two about what the transcript SAYS — the same
// "one document shape, several renderers" discipline the exporters themselves
// already live under.
//
// ⚠ `exportedAt` IS THE VERSION'S OWN TIMESTAMP, NOT `new Date()`. The Markdown
// projection puts `exportedAt` in its YAML front matter, so rendering with the
// wall clock would make the assembled prompt differ between the request-time
// budget check (#53) and the job-time one for no reason but the passage of
// time. The rendered document must be a pure function of the transcript, like
// everything else in this path.
//
// -----------------------------------------------------------------------------
// note → the source note's live `body`
// -----------------------------------------------------------------------------
//
// `notes.body` is by invariant (schema, spec §4.1) identical to the
// `note_versions` row at `current_version`, so this reads the denormalized live
// copy directly rather than joining to the version table. It is already
// Markdown; no conversion is involved.
//
// -----------------------------------------------------------------------------
// document → issue #51's extracted text. NOT IMPLEMENTED HERE, ON PURPOSE.
// -----------------------------------------------------------------------------
//
// See `resolveDocument` below for the seam and exactly what #51 fills in.
// =============================================================================

/** Where the source text came from, for a log line and nothing else. */
export interface ResolvedSource {
  text: string;
  /** Human-readable description of the source, for logs. Never user-facing. */
  describe: string;
}

/** What one resolution needs. Exactly the denormalized columns on a generation. */
export interface SourceSelector {
  sourceType: 'transcript' | 'note' | 'document';
  sourceTranscriptId: string | null;
  sourceNoteId: string | null;
  sourceObjectId: string | null;
}

/**
 * The metadata key `note.source.extract` records the extracted-text object
 * under, and the total reader for it.
 *
 * ⚠ RE-EXPORTED, NOT DEFINED HERE, since #51. They now live in
 * `notes/source-metadata.ts` — a pure module with no Nest and no Prisma — so
 * that the WRITER (the extraction handler) and the READER (this service) import
 * one definition rather than two that can drift. #49 declared them here first,
 * before a writer existed; the re-export keeps every existing importer working
 * and keeps the reason the constant exists at all visible from the seam it was
 * written for.
 */
export { EXTRACTED_OBJECT_ID_KEY, readExtractedObjectId };

@Injectable()
export class NoteSourceService {
  private readonly logger = new Logger(NoteSourceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly materialize: TranscriptMaterializeService,
    private readonly markdown: MarkdownTranscriptExporter,
    private readonly objects: NoteObjectsService,
  ) {}

  /**
   * The source text for one generation.
   *
   * ⚠ EVERY FAILURE HERE IS A DOMAIN FAILURE (`AiInputError`), never a thrown
   * bug. A transcript that was deleted, a source note that is gone, a document
   * whose text has not been extracted: all of them are permanent conditions
   * retrying cannot change, and all of them must show the user a sentence
   * rather than spending the generation's single attempt rediscovering them.
   */
  async resolve(selector: SourceSelector): Promise<ResolvedSource> {
    switch (selector.sourceType) {
      case 'transcript':
        return this.resolveTranscript(selector.sourceTranscriptId);
      case 'note':
        return this.resolveNote(selector.sourceNoteId);
      case 'document':
        return this.resolveDocument(selector.sourceObjectId);
      default:
        // Unreachable through Prisma's enum, reachable through a row written by
        // a later build and read by this one.
        throw new AiInputError(
          `This note's source type ("${String(selector.sourceType)}") is not one this ` +
            'version of the application knows how to read.',
        );
    }
  }

  // ---------------------------------------------------------------------------
  // transcript
  // ---------------------------------------------------------------------------

  private async resolveTranscript(transcriptId: string | null): Promise<ResolvedSource> {
    if (!transcriptId) {
      throw new AiInputError('This note names a transcript source but carries no transcript id.');
    }

    const transcript = await this.prisma.transcript.findUnique({
      where: { id: transcriptId },
      select: {
        id: true,
        title: true,
        language: true,
        durationMs: true,
        currentVersion: true,
        deletedAt: true,
      },
    });

    if (!transcript || transcript.deletedAt !== null) {
      throw new AiInputError(
        'The transcript this note was generated from is no longer available.',
      );
    }

    if (transcript.currentVersion < 1) {
      throw new AiInputError(
        `"${transcript.title}" has no transcribed text yet, so there is nothing to write a note from.`,
      );
    }

    // ⚠ THE CORRECTED STATE. See the header — this call, and specifically this
    // call, is why notes sit on top of epic #19 at all.
    const materialized = await this.materialize.materialize(
      transcript.id,
      transcript.currentVersion,
    );

    const version = await this.prisma.transcriptVersion.findUnique({
      where: {
        transcriptId_version: {
          transcriptId: transcript.id,
          version: transcript.currentVersion,
        },
      },
      select: { createdAt: true },
    });

    // A version row should always exist for a version `materialize` accepted;
    // the epoch is a deterministic fallback rather than a clock read, because
    // this document must not vary between two assemblies of the same prompt.
    const createdAt = version?.createdAt ?? new Date(0);

    const doc = buildExportDocument({
      transcriptId: transcript.id,
      title: transcript.title,
      language: transcript.language,
      durationMs: transcript.durationMs,
      version: transcript.currentVersion,
      createdAt,
      // NOT `new Date()` — see the header.
      exportedAt: createdAt,
      author: null,
      provider: null,
      state: materialized.state,
    });

    const text = await this.renderMarkdown(doc);

    return {
      text,
      describe: `transcript ${transcript.id} at version ${transcript.currentVersion}`,
    };
  }

  /** Render one document through the transcript module's Markdown exporter. */
  private async renderMarkdown(
    doc: Parameters<MarkdownTranscriptExporter['render']>[0],
  ): Promise<string> {
    const chunks: Buffer[] = [];

    const sink = new Writable({
      write(chunk: Buffer | string, _encoding, callback): void {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        callback();
      },
    });

    // Timestamps stay ON: a meeting note that can cite when something was said
    // is more useful than one that cannot, and the cost is a few tokens per
    // turn. Consecutive turns by one speaker are merged, which removes repeated
    // speaker headings from a long monologue — tokens the user pays for.
    await this.markdown.render(doc, { includeTimestamps: true, mergeConsecutive: true }, sink);

    return Buffer.concat(chunks).toString('utf8');
  }

  // ---------------------------------------------------------------------------
  // note
  // ---------------------------------------------------------------------------

  private async resolveNote(noteId: string | null): Promise<ResolvedSource> {
    if (!noteId) {
      throw new AiInputError('This note names another note as its source but carries no note id.');
    }

    const source = await this.prisma.note.findUnique({
      where: { id: noteId },
      select: { id: true, title: true, body: true, deletedAt: true },
    });

    if (!source || source.deletedAt !== null) {
      throw new AiInputError('The note this note was generated from is no longer available.');
    }

    if (source.body.trim().length === 0) {
      throw new AiInputError(
        `"${source.title}" has no content yet, so there is nothing to write a note from.`,
      );
    }

    return { text: source.body, describe: `note ${source.id}` };
  }

  // ---------------------------------------------------------------------------
  // document — FILLED IN BY ISSUE #51
  // ---------------------------------------------------------------------------

  /**
   * The extracted plain text of an uploaded document.
   *
   * ⚠ IT READS THE EXTRACTED TEXT OBJECT, NEVER THE RAW UPLOADED BYTES. The
   * contract is docs/specs/notes.md §4.7 and it needs no schema:
   * `note.source.extract` writes a SECOND `storage_objects` row holding the
   * plain text and records its id in the FIRST object's own `metadata` as
   * `{ extractedObjectId }`. This method reads that key, downloads that object,
   * and returns its contents. `note.generate` has no PDF parser, is not meant
   * to grow one, and handing a model base64 PDF bytes would spend the user's
   * own money producing confident nonsense.
   *
   * ⚠ IT NEVER RETURNS AN EMPTY STRING AS "the document had no text". An empty
   * source produces a fluent note about nothing, which is exactly the invisible
   * failure the token budget's refusal exists to avoid. Every way of arriving
   * at no text is an `AiInputError` with a sentence instead.
   *
   * THE THREE "not ready" CASES ARE DISTINGUISHED, because they need different
   * sentences and only one of them is worth waiting for:
   *
   *   • extraction RECORDED A PERMANENT FAILURE (an encrypted PDF, a scan with
   *     no text layer, a corrupt file) — the stored message is shown verbatim,
   *     because it is the one that says what to do about it, and for the
   *     scanned case that OCR is not supported;
   *   • extraction HAS NOT RUN YET — the job is queued or running, and the
   *     honest answer is "try again in a moment";
   *   • extraction SAYS it succeeded but the text object is gone — a purge or a
   *     bucket lifecycle rule got there first, which is not something a retry
   *     fixes.
   */
  private async resolveDocument(objectId: string | null): Promise<ResolvedSource> {
    if (!objectId) {
      throw new AiInputError('This note names a document source but carries no object id.');
    }

    const object = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
      // ⚠ `name`, NOT `filename` — `storage_objects` has no `filename` column,
      // and selecting one is a runtime Prisma error rather than a type error.
      select: { id: true, name: true, metadata: true },
    });

    if (!object) {
      throw new AiInputError('The document this note was generated from is no longer available.');
    }

    const extractedObjectId = readExtractedObjectId(object.metadata);

    if (!extractedObjectId) {
      throw new AiInputError(this.describeMissingExtraction(object.name, object.metadata));
    }

    const buffer = await this.objects.downloadBuffer(extractedObjectId);

    if (!buffer) {
      this.logger.warn(
        `Document ${object.id} names extracted text object ${extractedObjectId}, which has no ` +
          'bytes — it was deleted after extraction recorded it',
      );

      throw new AiInputError(
        `The text extracted from "${object.name}" is no longer available. Upload the document ` +
          'again to generate a note from it.',
      );
    }

    const text = buffer.toString('utf8');

    if (text.trim().length === 0) {
      // Defence in depth: the extractor refuses to record an empty success and
      // the node result schema refuses to accept one, so reaching here means a
      // row written by something neither of those guards. It is still a
      // sentence rather than a fluent note about nothing.
      throw new AiInputError(
        `No text could be read from "${object.name}", so there is nothing to write a note from.`,
      );
    }

    return { text, describe: `document ${object.id} (extracted text ${extractedObjectId})` };
  }

  /**
   * Why this document has no extracted text yet, in a sentence.
   *
   * The recorded failure message is preferred over anything this method could
   * compose, because it was written for the person who uploaded the file and
   * names the specific condition — including, for a scanned PDF, that OCR is
   * not supported. Falling back to "still being read" for an absent block is
   * correct: a source object with no extraction block at all is one whose job
   * has not settled.
   */
  private describeMissingExtraction(name: string, metadata: unknown): string {
    const recorded = readExtractionMetadata(metadata);

    if (recorded?.status === 'unextractable' && typeof recorded.message === 'string') {
      return recorded.message;
    }

    if (recorded?.status === 'unextractable') {
      return (
        `No text could be read from "${name}", so there is nothing to write a note from.`
      );
    }

    return (
      `"${name}" is still being read. Its text has not finished extracting yet — try again in ` +
      'a moment.'
    );
  }
}

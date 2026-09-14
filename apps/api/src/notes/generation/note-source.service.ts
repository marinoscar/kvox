import { Injectable, Logger } from '@nestjs/common';
import { Writable } from 'node:stream';

import { AiInputError } from '../../ai/ai-errors';
import { PrismaService } from '../../prisma/prisma.service';
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
 * The metadata key #51 records the extracted-text object under.
 *
 * Declared HERE as well as by #51 for the same reason a job type string is
 * declared before its handler exists: the writer and the reader are different
 * issues, and a constant both import is the only arrangement in which they
 * cannot spell it differently.
 */
export const EXTRACTED_OBJECT_ID_KEY = 'extractedObjectId';

@Injectable()
export class NoteSourceService {
  private readonly logger = new Logger(NoteSourceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly materialize: TranscriptMaterializeService,
    private readonly markdown: MarkdownTranscriptExporter,
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
  // document — THE SEAM FOR ISSUE #51
  // ---------------------------------------------------------------------------

  /**
   * The extracted plain text of an uploaded document.
   *
   * ⚠ ISSUE #51 FILLS THIS IN, AND THIS METHOD IS THE WHOLE SEAM. The contract
   * is already fixed by spec §4.7 and needs no schema: `note.source.extract`
   * writes a SECOND `storage_objects` row holding the extracted plain text and
   * records its id in the FIRST object's own `metadata` as
   * `{ extractedObjectId }`. This method reads that key, downloads that object,
   * and returns its contents.
   *
   * Until then it fails CLEANLY — a domain error with a sentence, not a thrown
   * bug and not a half-built download path. Two things it must never become:
   *
   *   • it must never read the RAW UPLOADED BYTES. `note.generate` has no PDF
   *     parser, is not meant to grow one, and handing a model a base64 PDF
   *     would spend the user's own money producing confident nonsense.
   *   • it must never return an empty string as "the document had no text".
   *     An empty source produces a fluent note about nothing, which is exactly
   *     the invisible failure the token budget's refusal exists to avoid.
   */
  private async resolveDocument(objectId: string | null): Promise<ResolvedSource> {
    if (!objectId) {
      throw new AiInputError('This note names a document source but carries no object id.');
    }

    const object = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
      select: { id: true, filename: true, metadata: true },
    });

    if (!object) {
      throw new AiInputError('The document this note was generated from is no longer available.');
    }

    const extractedObjectId = readExtractedObjectId(object.metadata);

    this.logger.warn(
      `Note generation asked for document source ${object.id} ` +
        `(extracted text object: ${extractedObjectId ?? 'none'}), which this build cannot read`,
    );

    throw new AiInputError(
      `Notes cannot yet be generated from uploaded documents such as "${object.filename}". ` +
        'Choose a transcript or another note as the source.',
    );
  }
}

/**
 * `{ extractedObjectId }` out of a storage object's metadata, or `null`.
 *
 * TOTAL OVER GARBAGE: `metadata` is JSONB written by another module and
 * possibly an earlier build, so it can be null, a string, an array, or an
 * object with the wrong field — every one of which means "no extracted text".
 */
export function readExtractedObjectId(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return null;
  }

  const value = (metadata as Record<string, unknown>)[EXTRACTED_OBJECT_ID_KEY];

  return typeof value === 'string' && value.length > 0 ? value : null;
}

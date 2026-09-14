// =============================================================================
// `note.source.extract` (issue #51, epic #45) — the epic's node-eligible type
// =============================================================================
//
// An uploaded PDF, `.txt` or `.md` becomes plain text `note.generate` can put
// in a prompt. The model cannot read a PDF's bytes, and `note.generate`
// deliberately has no parser of its own (spec §3.2) — so something has to do
// this, and CLAUDE.md's rule 1 settles what that something is: a PDF of any
// size outlives the request that uploaded it, so it is a queue job and not an
// inline step of the upload endpoint.
//
// -----------------------------------------------------------------------------
// WHY THIS TYPE IS NODE-ELIGIBLE, AND WHY THAT IS NOT A SPECIAL CASE
// -----------------------------------------------------------------------------
//
// CLAUDE.md's rule 2 makes node-eligibility the DEFAULT POSTURE: a type carries
// `nodeResultSchema` + `persistNodeResult` unless it genuinely cannot. This one
// genuinely can, and the test is worth spelling out because the sibling handler
// in this very module fails it:
//
//   • `note.generate` is server-only because it needs the USER'S OWN decrypted
//     vendor key, which is a credential no remote machine may hold and which no
//     `nodeSecretBroker` can scope down to one job.
//   • `note.source.extract` needs NOTHING but the bytes. It is pure CPU over a
//     file already in object storage, reachable by a presigned URL — which is
//     exactly the shape the node data plane exists for. No credential, no
//     database read in the middle, no vendor account.
//
// So it declares BOTH members, never one: a schema with no persist function
// describes a payload nobody can store, and a persist function with no schema
// would trust an unvalidated remote body. Eligibility stays DERIVED from the
// pair (`job-handler.interface.ts`) — there is no `nodeEligible` flag.
//
// -----------------------------------------------------------------------------
// ⚠ `process` AND `persistNodeResult` SHARE ONE WRITE, AND THAT IS THE POINT
// -----------------------------------------------------------------------------
//
// A node-eligible handler has two execution paths and they must reach the same
// row state, or a job's stored result depends on which executor happened to
// claim it — a divergence nothing catches by accident, because each path is
// tested on its own.
//
//   * `process` (in-process worker): download, extract here, then call
//     `recordExtraction`.
//   * `persistNodeResult` (a node extracted): parse, then call the SAME
//     `recordExtraction`.
//
// `recordExtraction` takes an `ExtractionOutcome` — the identical union both
// the local extractor and the wire schema produce — so the two paths are not
// merely similar, they are the same function applied to the same type.
//
// The ONE branch inside it is the transport, not the write: the server holds
// the extracted bytes and must upload them (`put`), while a node has already
// PUT them to the presigned URL and the server only records what landed
// (`recordUploaded`, which HEADs the key first). `persistNodeResult` does not
// re-download the source, does not re-extract, and does not "correct" text it
// dislikes — the moment the server recomputes, the node's answer is decorative
// and the reason for the node plane is gone.
//
// -----------------------------------------------------------------------------
// FAILURE IS A DOMAIN OUTCOME, NOT A CRASH
// -----------------------------------------------------------------------------
//
// An encrypted PDF, a scan with no text layer and a corrupt file are permanent:
// retrying re-asks a question whose answer cannot change. All three RETURN
// normally with a recorded reason and a sentence the UI can show — the same
// discipline the transcription pipeline applies to `ProviderInputError` (see
// CLAUDE.md's transcript-pipeline rule 3). The scanned case says plainly that
// OCR is not supported, because "extraction failed" would tell a user to try
// again and trying again cannot work.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job, StorageObject } from '@prisma/client';
import { Prisma } from '@prisma/client';

import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import {
  noteSourceExtractResultSchema,
  toExtractionOutcome,
  type NoteSourceExtractResult,
} from '../../jobs/contracts/note-source-extract.contract';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveStorageObjectInput } from '../../storage/storage-job-input';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../../storage/providers/storage-provider.interface';
import { extractDocumentText } from '../extraction';
import { normalizeDocumentMimeType } from '../extraction/document-format';
import {
  describeExtractionFailure,
  type ExtractionOutcome,
} from '../extraction/extraction-result';
import { NOTE_SOURCE_EXTRACT_JOB_TYPE } from '../job-types';
import { NoteObjectsService } from '../note-objects.service';
import {
  EXTRACTED_OBJECT_ID_KEY,
  EXTRACTION_METADATA_KEY,
  asMetadataObject,
  extractedTextStorageKey,
  type NoteSourceExtractionMetadata,
} from '../source-metadata';

/**
 * How long one extraction may run before the slot is freed.
 *
 * FIVE MINUTES, well under the deployment default (10 min) rather than over it.
 * A document is bounded by `ai.maxDocumentBytes` before it ever reaches a job,
 * so an extraction that has been running for five minutes is not a big file —
 * it is a pathological PDF pinning a CPU, and the useful thing to do with it is
 * give the slot back.
 */
const EXTRACT_MAX_RUNTIME_MS = 5 * 60 * 1000;

/** `mimeType` of the object holding the extracted text. */
const EXTRACTED_MIME_TYPE = 'text/plain; charset=utf-8';

/** Display name of the extracted-text object. Managed objects are never listed. */
const EXTRACTED_OBJECT_NAME = 'extracted.txt';

@Injectable()
export class NoteSourceExtractHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(NoteSourceExtractHandler.name);

  readonly type = NOTE_SOURCE_EXTRACT_JOB_TYPE;

  /**
   * Two numbers, and deliberately only two (`job-execution-profile.ts`).
   *
   * `maxAttempts: 3` — the deployment default, and correct here unlike
   * `note.generate`'s `1`: a retry of an extraction costs nothing on anybody's
   * vendor account and has no side effect a user can see twice. The permanent
   * conditions never reach a retry at all, because they return rather than
   * throw.
   */
  readonly profile: JobExecutionProfile = {
    maxRuntimeMs: EXTRACT_MAX_RUNTIME_MS,
    maxAttempts: 3,
  };

  /**
   * THE FIRST OF THE TWO MEMBERS THAT MAKE THIS TYPE NODE-ELIGIBLE.
   *
   * It lives in `jobs/contracts/` rather than inline because a second reader
   * needs it: `GET /api/nodes/job-types` converts it with `z.toJSONSchema()` so
   * a client validates a result against the server's own definition rather than
   * against a copy it carries.
   */
  readonly nodeResultSchema = noteSourceExtractResultSchema;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly objects: NoteObjectsService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /** Self-registration — the only wiring a handler needs. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  // ===========================================================================
  // The server-side path
  // ===========================================================================

  /**
   * Download the source document and extract its text here, on the API server.
   *
   * This is what runs when the IN-PROCESS worker claims the job. A node is an
   * option, never a requirement — a deployment that runs no nodes must still be
   * able to execute every type it enqueues, or "node-eligible" would mean "the
   * fleet is mandatory".
   *
   * ⚠ ALREADY-EXTRACTED IS A NO-OP, NOT A SECOND EXTRACTION. The queue is
   * at-least-once, so a duplicate delivery is ordinary rather than exceptional;
   * re-extracting would write a second text object the first one's metadata no
   * longer names, which nothing would ever delete.
   */
  async process(job: Job): Promise<void> {
    const object = await resolveStorageObjectInput(this.prisma, job);

    if (this.alreadySettled(object)) {
      this.logger.log(
        `Source object ${object.id} already carries an extraction result; job ${job.id} is a no-op`,
      );

      return;
    }

    const mimeType = normalizeDocumentMimeType(object.mimeType);

    if (!mimeType) {
      // Unreachable through the upload endpoint, which refuses anything else at
      // the door. Reachable through a row written by a build that accepted a
      // fourth type — and a permanent condition either way, so it records a
      // reason rather than throwing into a retry that cannot help.
      await this.recordExtraction(
        job,
        object,
        { outcome: 'unextractable', reason: 'corrupt_file', pageCount: null },
        'server',
      );

      return;
    }

    const bytes = await this.readSource(object);
    const outcome = await extractDocumentText(bytes, mimeType);

    await this.recordExtraction(job, object, outcome, 'server');
  }

  // ===========================================================================
  // The node path
  // ===========================================================================

  /**
   * Where a node must PUT this job's extracted text.
   *
   * `notes/sources/<sourceObjectId>/extracted-<jobId>.txt` rather than the data
   * plane's default `node-outputs/<jobId>/<uuid>`, because the extracted text
   * is a DURABLE, EXTERNALLY-REFERENCED artifact: the source object's own
   * metadata names it (spec §4.7) and a note generated from it reads it months
   * later. An object outside a prefix this module owns would outlive everything
   * that knows about it.
   *
   * Idempotent by construction — both inputs are fixed on the job row before
   * this can be called, so a node asking again after a timed-out transfer gets
   * the same key rather than orphaning the first upload.
   */
  async deriveOutputKey(job: Job): Promise<string> {
    const object = await resolveStorageObjectInput(this.prisma, job);

    return extractedTextStorageKey(object.id, job.id);
  }

  /**
   * THE SECOND MEMBER THAT MAKES THIS TYPE NODE-ELIGIBLE: writes down a result
   * a node computed and `nodeResultSchema` has already validated.
   *
   * ⚠ IT PARSES AGAIN, DELIBERATELY. The interface hands this method
   * `result: unknown` because the value came from off-machine, so narrowing it
   * is the only way to touch a field at all — and re-parsing rather than casting
   * means a future caller that forgot to validate (a fork's own admin
   * "re-persist" tool, say) cannot write an arbitrary object into the database
   * through this method.
   *
   * PERSIST ONLY. No download of the source, no re-extraction, no second
   * opinion on the text.
   */
  async persistNodeResult(job: Job, result: unknown): Promise<void> {
    const parsed: NoteSourceExtractResult = this.nodeResultSchema.parse(result);

    const object = await resolveStorageObjectInput(this.prisma, job);

    if (this.alreadySettled(object)) {
      this.logger.log(
        `Source object ${object.id} already carries an extraction result; discarding the ` +
          `duplicate node result for job ${job.id}`,
      );

      return;
    }

    // ⚠ ONE CONVERSION, NOT A SECOND INTERPRETATION. `toExtractionOutcome` maps
    // the wire shape onto the very type the server-side extractor produces, so
    // the line below is the SAME call `process` makes with the SAME kind of
    // argument — which is what "one write, two paths" actually means.
    await this.recordExtraction(job, object, toExtractionOutcome(parsed), 'node');
  }

  // ===========================================================================
  // The one write, shared by both paths
  // ===========================================================================

  /**
   * Record one extraction outcome against its source object.
   *
   * TWO EFFECTS, IN THIS ORDER, AND THE ORDER MATTERS:
   *
   *   1. On success, the extracted-text `storage_objects` row — created from
   *      the server's own bytes (`put`) or recorded after checking the node's
   *      upload actually landed (`recordUploaded`). This is the ONLY branch in
   *      this method, and it is about TRANSPORT rather than about what is
   *      stored: both arms produce one managed row at one key holding the same
   *      UTF-8 text.
   *   2. The source object's metadata, merged rather than replaced, carrying
   *      `extractedObjectId` (what `note.generate` reads) and the namespaced
   *      block (what a UI shows).
   *
   * The metadata is written LAST so the id it publishes always points at bytes
   * that already exist. The failure mode of this order is an orphaned text
   * object nothing references — harmless, and swept by the bucket's lifecycle
   * policy. The other order would publish an id whose object may never arrive.
   */
  private async recordExtraction(
    job: Job,
    source: StorageObject,
    outcome: ExtractionOutcome,
    extractedBy: NoteSourceExtractionMetadata['extractedBy'],
  ): Promise<void> {
    if (outcome.outcome === 'unextractable') {
      await this.writeMetadata(source, null, {
        status: 'unextractable',
        reason: outcome.reason,
        message: describeExtractionFailure(outcome.reason),
        pageCount: outcome.pageCount,
        extractedAt: new Date().toISOString(),
        extractedBy,
      });

      this.logger.log(
        `Source object ${source.id} yielded no text (${outcome.reason}); job ${job.id} ` +
          `settled by the ${extractedBy} path`,
      );

      return;
    }

    const storageKey = extractedTextStorageKey(source.id, job.id);
    const body = Buffer.from(outcome.text, 'utf8');

    const extracted =
      extractedBy === 'server'
        ? await this.objects.put({
            storageKey,
            name: EXTRACTED_OBJECT_NAME,
            mimeType: EXTRACTED_MIME_TYPE,
            body,
            // The SOURCE DOCUMENT'S owner, never the account that happened to
            // trigger the job.
            ownerId: source.uploadedById ?? '',
            metadata: { sourceObjectId: source.id, jobId: job.id, extractedBy },
          })
        : await this.objects.recordUploaded({
            storageKey,
            name: EXTRACTED_OBJECT_NAME,
            mimeType: EXTRACTED_MIME_TYPE,
            size: body.byteLength,
            ownerId: source.uploadedById ?? '',
            metadata: { sourceObjectId: source.id, jobId: job.id, extractedBy },
          });

    await this.writeMetadata(source, extracted.id, {
      status: 'extracted',
      pageCount: outcome.pageCount,
      encoding: outcome.encoding,
      characters: outcome.text.length,
      extractedAt: new Date().toISOString(),
      extractedBy,
    });

    this.logger.log(
      `Extracted ${outcome.text.length} characters from source object ${source.id} ` +
        `into ${extracted.id} (job ${job.id}, ${extractedBy} path)`,
    );
  }

  /**
   * Merge the extraction result into the source object's `metadata`.
   *
   * READ-MERGE-WRITE RATHER THAN A JSONB PATH UPDATE, because Prisma has no
   * partial-JSON update: `data: { metadata }` replaces the whole column, so
   * writing only these two keys directly would delete everything the upload
   * pipeline and the metadata endpoint put there. The read is what makes this
   * additive — the same shape `example-checksum.handler.ts` uses.
   */
  private async writeMetadata(
    source: StorageObject,
    extractedObjectId: string | null,
    block: NoteSourceExtractionMetadata,
  ): Promise<void> {
    const existing = asMetadataObject(source.metadata) ?? {};

    const metadata: Record<string, unknown> = {
      ...existing,
      [EXTRACTION_METADATA_KEY]: block,
    };

    if (extractedObjectId) {
      metadata[EXTRACTED_OBJECT_ID_KEY] = extractedObjectId;
    }

    await this.prisma.storageObject.update({
      where: { id: source.id },
      // Cast through `unknown`: `InputJsonValue` is a recursive union a
      // structurally-typed `Record<string, unknown>` cannot be narrowed to, and
      // `ObjectsService.updateMetadata` writes the same column the same way.
      data: { metadata: metadata as unknown as Prisma.InputJsonValue },
    });
  }

  /** Has some executor already settled this source document? */
  private alreadySettled(source: StorageObject): boolean {
    const existing = asMetadataObject(source.metadata);

    if (!existing) return false;

    return (
      typeof existing[EXTRACTED_OBJECT_ID_KEY] === 'string' ||
      asMetadataObject(existing[EXTRACTION_METADATA_KEY]) !== null
    );
  }

  /**
   * The source document's bytes, as one buffer.
   *
   * BUFFERED, NOT STREAMED, and unlike `example.checksum` that is correct here:
   * pdf.js needs the whole file in memory to resolve a cross-reference table
   * that lives at the END of a PDF, so there is no streaming extraction to do.
   * What bounds the memory is `ai.maxDocumentBytes`, enforced at the door by
   * the upload endpoint before a job exists — which is why that ceiling is a
   * setting rather than a constant.
   */
  private async readSource(object: StorageObject): Promise<Uint8Array> {
    const stream = await this.storage.download(object.storageKey);
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }

    return new Uint8Array(Buffer.concat(chunks));
  }
}

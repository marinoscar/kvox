// =============================================================================
// `example.checksum` — the template's NODE-ELIGIBLE worked example
// (issue #269, epic #254)
// =============================================================================
//
// `example-echo.handler.ts` next door is the server-only worked example: one
// class, one `process`, nothing else. This is the other half of the same
// lesson — the SAME four steps plus the two optional members that make a type
// runnable on a machine with no database access:
//
//     node   →  ask for a download URL, stream the bytes, hash them
//     server →  validate the result, write it down
//
// -----------------------------------------------------------------------------
// WHY THIS EXAMPLE AND NOT A TOY (OR NOTHING AT ALL)
// -----------------------------------------------------------------------------
//
// REJECTED: shipping no node-eligible handler, on the argument that "a
// node-eligible handler is a product decision, not framework". That argument
// is what #268 shipped under, and it leaves the fleet UNTESTABLE END TO END:
// `NodesService.claimJobs` intersects with the registry's node-eligible types,
// so with no such type registered anywhere, every claim by every node
// correctly returns an empty list. The entire data plane — claim, download
// URL, compute, submit, validate, persist — could be wrong in any way at all
// and nothing in this repository would notice, because nothing could reach
// it. An example that exercises the path is not decoration; it is the only
// live proof the path exists.
//
// REJECTED: a node-eligible `example.echo` (compute nothing, post `{ ok:
// true }`). It would exercise the control plane and skip the entire data
// plane — no input resolution, no download URL, no streaming, no byte count —
// which is precisely the half #269 adds and precisely the half that is easy to
// get wrong.
//
// REJECTED: anything domain-specific — image thumbnails, PDF page counts,
// audio transcodes, an ML inference. Each needs a native dependency
// (`sharp`, `pdfium`, `ffmpeg`, a model runtime), which a template must not
// force on a fork that will delete this handler on day one, and which turns
// "can I run a node?" into a packaging problem before it is a queue problem.
//
// SHA-256 over a stored object hits every requirement at once: it is
// provider-agnostic, it needs nothing beyond `node:crypto`, it is genuinely
// useful (integrity verification, deduplication, a stable content id), it is
// CPU-bound and streaming — the exact shape of work worth moving off the API
// server — and it exercises every branch the data plane has.
//
// -----------------------------------------------------------------------------
// ⚠ `process` AND `persistNodeResult` SHARE ONE WRITE, AND THAT IS THE POINT
// -----------------------------------------------------------------------------
//
// A node-eligible handler has TWO execution paths and they must reach the same
// row state, or a job's stored result depends on which executor happened to
// claim it — a divergence nothing tests by accident, because each path is
// tested on its own:
//
//   * `process` (in-process worker): resolve the input, stream it, hash it,
//     then call the shared `writeChecksum`.
//   * `persistNodeResult` (a node did the hashing): parse, then call the SAME
//     `writeChecksum`.
//
// The compute half differs; the persist half is one method called from both.
// Note what `persistNodeResult` does NOT do: it does not re-download the
// object, does not re-hash it, and does not "correct" a digest it dislikes.
// `job-handler.interface.ts` states that rule and states why — the moment the
// server recomputes, the node's answer is decorative and the reason for the
// node plane is gone.
// =============================================================================

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job, Prisma, StorageObject } from '@prisma/client';
import { createHash } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../../storage/providers/storage-provider.interface';
import type { StorageProvider } from '../../storage/providers/storage-provider.interface';
import { resolveStorageObjectInput } from '../../storage/storage-job-input';
import {
  ExampleChecksumResult,
  exampleChecksumResultSchema,
} from '../contracts/example-checksum.contract';
import { JobHandler } from '../job-handler.interface';
import { JobHandlerRegistry } from '../job-handler.registry';

/**
 * Where the computed checksum lands inside `StorageObject.metadata`.
 *
 * NESTED UNDER ONE KEY RATHER THAN SPREAD ACROSS THE TOP LEVEL. `metadata` is
 * a shared JSONB bag: the upload pipeline's processors write into it
 * (`example-metadata.processor.ts`), `PATCH /storage/objects/:id/metadata`
 * merges user-supplied keys into it, and a fork will add more. Two writers
 * that both put a bare `bytes` at the top level silently overwrite each other,
 * and the loser is whichever ran first. One namespaced key means this
 * handler's write can only ever collide with itself.
 */
export const CHECKSUM_METADATA_KEY = 'checksum';

/** What this handler stores under `metadata.checksum`. */
export interface ChecksumMetadata {
  algorithm: 'sha256';
  sha256: string;
  bytes: number;
  /** ISO 8601 — when the result was written, not when the bytes were hashed. */
  computedAt: string;
  /** Which executor produced it. Useful when a fleet result looks wrong. */
  computedBy: 'server' | 'node';
}

@Injectable()
export class ExampleChecksumHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(ExampleChecksumHandler.name);

  /**
   * Example-shaped and product-neutral, exactly like `example.echo`: anybody
   * reading a `jobs` row, a log line or the admin dashboard can tell this is
   * the template's demonstration and not something their application depends
   * on. Delete the class and the type disappears with no migration.
   */
  readonly type = 'example.checksum';

  /**
   * THE FIRST OF THE TWO MEMBERS THAT MAKE THIS TYPE NODE-ELIGIBLE.
   *
   * It lives in `../contracts/` rather than inline because a second reader
   * needs it: `GET /api/nodes/job-types` converts it with `z.toJSONSchema()`
   * so a client validates against the server's own definition. See that
   * folder's README, including why a shared `packages/job-contracts`
   * workspace was rejected.
   */
  readonly nodeResultSchema = exampleChecksumResultSchema;

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER)
    private readonly storage: StorageProvider
  ) {}

  /** Self-registration — the only wiring a handler needs. */
  onModuleInit(): void {
    this.registry.register(this);
  }

  // ===========================================================================
  // The server-side path
  // ===========================================================================

  /**
   * Streams the job's input object and hashes it here, on the API server.
   *
   * This is what runs when the IN-PROCESS worker claims the job — a node is an
   * option, never a requirement, and a deployment that runs no nodes must
   * still be able to execute every type it enqueues. A handler that only
   * worked on a node would make the fleet mandatory, which is the opposite of
   * what "node-eligible" means.
   *
   * `download()` streams rather than buffering, and the hash is updated per
   * chunk, so a 10 GB object costs a hash context rather than 10 GB of heap.
   * The identical property is what makes this work worth moving to a node at
   * all: it is CPU over a stream, with no database access in the middle.
   *
   * THROW TO FAIL, with no `try`/`catch`: a provider error, a missing object
   * or a truncated stream all become `Job.lastError` plus a retry, which is
   * the correct behaviour for every one of them.
   */
  async process(job: Job): Promise<void> {
    // Named failures, never an empty path — see `storage-job-input.ts`'s
    // header for the `ENOENT … open ''` failure this prevents.
    const object = await resolveStorageObjectInput(this.prisma, job);

    const stream = await this.storage.download(object.storageKey);
    const hash = createHash('sha256');
    let bytes = 0;

    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      hash.update(buffer);
      bytes += buffer.length;
    }

    await this.writeChecksum(
      object,
      { sha256: hash.digest('hex'), bytes },
      'server'
    );

    this.logger.log(
      `Checksummed storage object ${object.id} for job ${job.id} on the server ` +
        `(${bytes} bytes)`
    );
  }

  // ===========================================================================
  // The node-computed path
  // ===========================================================================

  /**
   * THE SECOND MEMBER THAT MAKES THIS TYPE NODE-ELIGIBLE: writes down a
   * result a node computed and `nodeResultSchema` already validated.
   *
   * ⚠ IT PARSES AGAIN, DELIBERATELY, and the second parse is not paranoia
   * about `NodesService` — it is a TYPE-SYSTEM requirement with a safety
   * dividend. The interface hands this method `result: unknown` (the value
   * came from off-machine; `job-handler.interface.ts` explains why the
   * parameter type is deliberate), so narrowing it is the only way to touch a
   * field at all. Re-parsing rather than casting means a future caller that
   * forgets to validate — a fork's own admin "re-persist" tool, say — cannot
   * write an arbitrary object into the database through this method, and the
   * cost is one schema parse of a two-field object.
   *
   * PERSIST ONLY. No download, no re-hash, no provider call. The row is read
   * because the write is a MERGE into a shared JSONB column, not because
   * anything about the result is being re-derived.
   */
  async persistNodeResult(job: Job, result: unknown): Promise<void> {
    const parsed: ExampleChecksumResult = this.nodeResultSchema.parse(result);

    // The same resolver `process` uses, for the same three named failures.
    // Reusing it here means a row that vanished between the node's download
    // and its submission fails with "input object not found" rather than a
    // Prisma "record to update not found" — and a row that has lost its
    // storage key is a row whose checksum would describe bytes that are gone,
    // which is worth refusing rather than storing.
    const object = await resolveStorageObjectInput(this.prisma, job);

    await this.writeChecksum(object, parsed, 'node');

    this.logger.log(
      `Persisted a node-computed checksum for storage object ${object.id} ` +
        `(job ${job.id}, ${parsed.bytes} bytes)`
    );
  }

  // ===========================================================================
  // The one write, shared by both paths
  // ===========================================================================

  /**
   * Merges the checksum into `metadata` under `CHECKSUM_METADATA_KEY`.
   *
   * READ-MERGE-WRITE RATHER THAN A JSONB PATH UPDATE, because Prisma has no
   * partial-JSON update: `data: { metadata }` replaces the whole column, so
   * writing `{ checksum }` directly would delete every key the upload
   * pipeline and the metadata endpoint put there. The read is what makes this
   * additive.
   *
   * A SIZE MISMATCH IS LOGGED, NEVER "FIXED". `StorageObject.size` is `0`
   * until post-processing fills it in for a simple upload, so a mismatch is
   * usually the column being stale rather than the node being wrong — and
   * this method is not allowed to decide which (see the file header's rule
   * about persist-only). Reporting it puts the discrepancy in the log for a
   * human; correcting it would be this server overruling the executor that
   * actually read the bytes.
   */
  private async writeChecksum(
    object: StorageObject,
    result: ExampleChecksumResult,
    computedBy: ChecksumMetadata['computedBy']
  ): Promise<void> {
    const declaredSize = Number(object.size);

    if (declaredSize > 0 && declaredSize !== result.bytes) {
      this.logger.warn(
        `Storage object ${object.id} declares ${declaredSize} bytes but the ${computedBy} ` +
          `executor hashed ${result.bytes}. Storing what was actually read; the row's size ` +
          `may be stale (it is 0 until post-processing for a simple upload).`
      );
    }

    const existing =
      object.metadata !== null &&
      typeof object.metadata === 'object' &&
      !Array.isArray(object.metadata)
        ? (object.metadata as Record<string, unknown>)
        : {};

    const checksum: ChecksumMetadata = {
      algorithm: 'sha256',
      sha256: result.sha256,
      bytes: result.bytes,
      computedAt: new Date().toISOString(),
      computedBy,
    };

    const metadata: Record<string, unknown> = {
      ...existing,
      [CHECKSUM_METADATA_KEY]: checksum,
    };

    await this.prisma.storageObject.update({
      where: { id: object.id },
      // Cast through `unknown`: `InputJsonValue` is a recursive union that a
      // structurally-typed `Record<string, unknown>` cannot be narrowed to,
      // and `ObjectsService.updateMetadata` writes the same column the same
      // way. The value is a plain JSON object by construction — every field of
      // `ChecksumMetadata` is a string or a number.
      data: { metadata: metadata as unknown as Prisma.InputJsonValue },
    });
  }
}

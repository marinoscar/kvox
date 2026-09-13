// =============================================================================
// The data plane's request and response bodies (issue #269, epic #254)
// =============================================================================
//
// #268 gave a node a CONTROL plane: claim a job, renew its lease, report an
// outcome. What it could not do was read a single byte or write one, because
// a node holds no storage credentials — by design, and permanently. These
// bodies are the whole of the answer.
//
// -----------------------------------------------------------------------------
// THE SHAPE OF THE SOLUTION, AND THE TWO ALTERNATIVES IT BEATS
// -----------------------------------------------------------------------------
//
// The server mints a SHORT-LIVED, SINGLE-OBJECT signed URL and the node talks
// to the storage provider directly. Bytes never pass through the API.
//
// REJECTED: PROXYING BYTES THROUGH THE API (`GET /nodes/:id/jobs/:jobId/input`
// streaming the object, `POST …/output` accepting it). It is the smallest
// diff and it is the worst outcome. Every byte of every job would cross the
// API process twice — once in, once out — so the API's memory, its event loop
// and its egress bill become a function of how much work the FLEET is doing,
// which is the exact coupling a worker node exists to remove. A ten-node fleet
// hashing 1 GB objects would saturate the API before it saturated anything
// that was actually computing. It also puts long-lived streaming connections
// on the same process that serves interactive requests, so one large transfer
// degrades every page load, and a node on a slow link holds a request open for
// minutes against every timeout in the stack (Nginx, Fastify, the platform's
// load balancer) — each of which would have to be raised, for everyone.
//
// REJECTED: GIVING NODES STORAGE CREDENTIALS. Also small, also worse. A
// credential handed to a node is a bucket-wide capability sitting in a config
// file on a machine this deployment may not own, for as long as that machine
// exists — it does not expire when the job ends, it is not scoped to one
// object, and it cannot be revoked without rotating it for every other holder.
// A node compromised on Tuesday can read every object in the bucket on
// Friday. The signed URL below is the same capability reduced along three
// axes at once: ONE object, ONE verb, and MINUTES. Nothing has to be rotated
// when a node is decommissioned, because a decommissioned node holds nothing.
//
// -----------------------------------------------------------------------------
// ⚠ THE SERVER CHOOSES THE UPLOAD KEY. THE NODE NEVER DOES.
// -----------------------------------------------------------------------------
//
// REJECTED: `{ key: "outputs/my-thing.bin" }` in the upload request. A signed
// PUT is an unconditional overwrite of exactly the key it was signed for, so a
// key taken from the request body is a write primitive over the entire bucket,
// handed to the least trustworthy participant. `../../etc/config.json`,
// `uploads/<someone-else's-object>` and the storage key of any row in
// `storage_objects` are all just strings, and the provider will not object to
// any of them: S3 keys are opaque, `..` is not special, and there is no
// filesystem to refuse the traversal. The damage is silent — a job that
// "succeeded" while overwriting another user's file.
//
// The key is therefore derived server-side from the job id and a fresh UUID
// (`NodeDataPlaneService.createUploadTarget`), and a node-supplied one is
// REFUSED rather than silently ignored. Both are safe; the difference is what
// the node's author learns. Ignoring means their `key` field vanishes without
// a word: the upload succeeds, the bytes land somewhere they did not choose,
// and their code goes on referring to a path with nothing at it. That bug is
// found days later by a person, not minutes later by a machine. A `400` naming
// the field is found on the first run, by the person who just wrote it, and it
// costs a correct client exactly nothing — no legitimate node ever sends the
// field.
// =============================================================================

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Cap on a node-declared `Content-Type`.
 *
 * It ends up in a signed header, so it is bounded for the same reason every
 * other node-supplied string in this folder is: it arrives from a machine
 * this deployment may not own.
 */
const MAX_CONTENT_TYPE_LENGTH = 255;

// =============================================================================
// POST /nodes/:id/jobs/:jobId/download-url
// =============================================================================
//
// NO BODY, DELIBERATELY. Everything the server needs is already on the path
// (which node, which job) and in the row (which object). There is nothing a
// node could usefully say here, and — see the header — nothing it is allowed
// to say about WHICH bytes it gets: that is the job's `subjectId`, resolved on
// the server. A DTO whose only field was `expiresIn` was considered and
// dropped for the same reason a node-supplied lease was dropped in #268: the
// bound exists to limit the blast radius of a leaked URL, so the party the
// bound protects against does not get to set it.
//
// It is a POST rather than a GET even though it reads nothing, because it
// MINTS A CREDENTIAL. A GET's URL is the thing every layer between here and
// the node writes down — proxy access logs, browser history, a CDN cache key,
// an APM trace's endpoint label — and a response body containing a bearer URL
// has no business being cacheable by anything. POST is uncacheable by default
// and carries no such expectation.

// =============================================================================
// POST /nodes/:id/jobs/:jobId/upload-url
// =============================================================================

/**
 * What a node may say when asking for somewhere to write.
 *
 * ⚠ `z.looseObject` RATHER THAN `z.strictObject`, AND THE REASON IS THE ERROR
 * MESSAGE. Strict mode rejects an unknown key with a perfectly good Zod issue
 * naming it — and that issue is then DESTROYED on the way out, because
 * `http-exception.filter.ts` rebuilds every error body from a fixed key
 * allowlist (`message`, `code`, `details`) and the validation pipe puts its
 * issues under `errors`. The node would receive a bare
 * `400 "Validation failed"`, which for the one field this endpoint most needs
 * to talk about — `key` — is the least useful answer available.
 *
 * So unknown keys are CAPTURED here and refused in
 * `NodeDataPlaneService.createUploadTarget`, which can raise a
 * `BadRequestException` carrying a message that names the field, explains that
 * the server chooses the key, and survives the filter intact. The security
 * outcome is identical either way (the key is never read); what differs is
 * whether the node's author is told why.
 *
 * `.default({})` so a node with nothing to declare may send an EMPTY BODY
 * rather than being required to send `{}` to satisfy a parser.
 */
export const nodeUploadUrlSchema = z
  .looseObject({
    /**
     * The `Content-Type` the node will send on its PUT.
     *
     * ⚠ IT BECOMES PART OF THE SIGNATURE. A node that declares it MUST send
     * exactly this header, or the provider answers `SignatureDoesNotMatch` —
     * an error that names the signature and not the header that broke it. A
     * node that is unsure should omit it and send whatever it likes.
     */
    contentType: z
      .string()
      .trim()
      .min(1)
      .max(MAX_CONTENT_TYPE_LENGTH)
      .optional(),
  })
  .default({});

export class NodeUploadUrlDto extends createZodDto(nodeUploadUrlSchema) {}

// =============================================================================
// Responses
// =============================================================================

/** The response to `POST /nodes/:id/jobs/:jobId/download-url`. */
export class NodeDownloadUrlResponseDto {
  @ApiProperty({
    description:
      'A short-lived signed GET for this job’s input object. Fetch it DIRECTLY from the ' +
      'storage provider — the bytes never pass through this API. Treat it as a secret: it ' +
      'is a bearer capability for that one object until it expires, so do not log it, do ' +
      'not write it to disk, and do not pass it to another process.',
  })
  url!: string;

  @ApiProperty({
    description:
      'Seconds until the URL stops working. Bounded by the server and not negotiable; ask ' +
      'again if a transfer needs longer, which is cheap while the lease is live.',
  })
  expiresIn!: number;

  @ApiProperty({
    description: 'ISO 8601 timestamp the URL stops working — `expiresIn` as an absolute time.',
  })
  expiresAt!: string;

  @ApiProperty({
    description:
      'The storage object this job names as its input, for correlation in the node’s own logs.',
  })
  objectId!: string;

  @ApiProperty({
    description:
      'The object’s recorded size in bytes, as a decimal STRING (the column is a 64-bit ' +
      'integer and JSON has no such number). `"0"` means the size was never recorded — a ' +
      'simple upload leaves it 0 until post-processing — so it is a progress hint, never a ' +
      'contract the node should verify against.',
  })
  size!: string;

  @ApiProperty({
    description: 'The object’s recorded MIME type, for a node that decodes rather than streams.',
  })
  mimeType!: string;
}

/** The response to `POST /nodes/:id/jobs/:jobId/upload-url`. */
export class NodeUploadUrlResponseDto {
  @ApiProperty({
    description:
      'A short-lived signed PUT accepting ONE request carrying the whole body. Upload ' +
      'DIRECTLY to the storage provider. If `contentType` was supplied, send exactly that ' +
      '`Content-Type` header or the signature will not match. Treat the URL as a secret.',
  })
  url!: string;

  @ApiProperty({
    description:
      'The storage key the server chose for this output. Report it back in the job’s result ' +
      'if the handler needs to record where the bytes went — a node cannot choose this, and ' +
      'sending a `key` in the request is refused with `400`.',
  })
  key!: string;

  @ApiProperty({ description: 'Seconds until the URL stops working.' })
  expiresIn!: number;

  @ApiProperty({ description: 'ISO 8601 timestamp the URL stops working.' })
  expiresAt!: string;
}

/** One node-eligible job type, with the contract its results must satisfy. */
export class NodeJobTypeDto {
  @ApiProperty({ description: 'The `Job.type` key — what a node registers and claims.' })
  type!: string;

  @ApiProperty({
    description:
      'Display label for the type, falling back to the raw key when none is mapped.',
  })
  label!: string;

  @ApiPropertyOptional({
    description:
      'JSON Schema (2020-12) for the `result` this type’s submissions must carry, generated ' +
      'from the server’s own Zod schema — so a client validates against the definition this ' +
      'server will actually enforce, not a copy. `null` on the rare type whose schema has no ' +
      'JSON Schema representation; validate server-side by submitting in that case.',
    nullable: true,
    type: Object,
  })
  resultSchema!: Record<string, unknown> | null;
}

/** The response to `GET /nodes/job-types`. */
export class NodeJobTypesResponseDto {
  @ApiProperty({
    description:
      'Every job type this server could accept a node-computed result for — derived from the ' +
      'handler registry, so a fork’s own types appear here with no list to edit. A type ' +
      'absent from this list can never be claimed by a node, whatever the node registered.',
    type: [NodeJobTypeDto],
  })
  types!: NodeJobTypeDto[];
}

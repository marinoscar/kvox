// =============================================================================
// The per-job secret request and response bodies (issue #349, epic #345)
// =============================================================================
//
// #269 gave a node a way to move BYTES with no storage credentials. This gives
// it a way to hold a CREDENTIAL for exactly one job, for exactly as long as it
// holds that job's lease. `job-secret-broker.ts` carries the argument for why
// the credential is brokered per job at all, and what the three rejected
// alternatives were; this file is about the wire shape, which has two
// properties worth stating on their own.
//
// -----------------------------------------------------------------------------
// ⚠ THE REQUEST BODY CARRIES NOTHING, AND ANY FIELD IS A 400
// -----------------------------------------------------------------------------
//
// Everything the server needs is already on the path (which node) and in the
// row (which job, which type, which broker, which lease). There is nothing a
// node could usefully say — and, far more importantly, nothing it is ALLOWED to
// say: A NODE MAY NOT REQUEST A SECRET IT WAS NOT ASSIGNED. A `kind`, a
// `scope`, a `database`, a `ttl` in the body would each be a node choosing some
// part of a credential's shape, and every one of those is the server's choice
// derived from the job the node is holding.
//
// So the refusal is the same one `NodeUploadUrlDto` makes about `key`, applied
// to a body with no permitted fields at all — including the `ttl` case, which
// is the one somebody will genuinely want. A node-chosen lifetime is refused
// for the reason #268 refused a node-chosen lease: the bound exists to limit
// the blast radius of a leaked credential, so the party the bound protects
// against does not get to set it. The credential is bounded by the job's lease,
// which the node is already renewing (#347), and there is deliberately no
// second clock.
//
// `z.looseObject`, NOT `z.strictObject`, and the reason is the error message —
// the identical reasoning `node-data-plane.dto.ts` records. Strict mode's
// perfectly good Zod issue is DESTROYED on the way out, because
// `http-exception.filter.ts` rebuilds every error body from a fixed key
// allowlist and the validation pipe files its issues under `errors`; the node
// would receive a bare `400 "Validation failed"` naming nothing. Unknown keys
// are therefore CAPTURED here and refused in `NodeSecretBrokerService`, which
// can raise a message that names the field and survives the filter intact. The
// security outcome is identical either way — no field is ever read — and what
// differs is whether the node's author is told why.
//
// -----------------------------------------------------------------------------
// POST, NOT GET, AND `Cache-Control: no-store`
// -----------------------------------------------------------------------------
//
// The same reason §15 already gives for the two data-plane routes, and it
// applies harder here because what comes back is not a scoped, minutes-long URL
// but a credential. A `GET`'s URL is what every layer between the server and
// the node writes down — proxy access logs, a CDN cache key, an APM trace's
// endpoint label — and a response body containing a credential has no business
// being cacheable by anything. `POST` is uncacheable by default; `no-store` says
// so out loud for the intermediary that decides to be clever anyway.
// =============================================================================

import { ApiProperty } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * What a node may say when asking for its job's credential: NOTHING.
 *
 * `.default({})` so a node with nothing to declare may send an empty body
 * rather than being made to send `{}` to satisfy a parser — and since there is
 * nothing it MAY declare, an empty body is the only correct request. Anything
 * present is captured by the loose object and refused by name in the service.
 */
export const nodeJobSecretRequestSchema = z.looseObject({}).default({});

export class NodeJobSecretRequestDto extends createZodDto(
  nodeJobSecretRequestSchema
) {}

/** The response to `POST /nodes/:id/jobs/:jobId/secret`. */
export class NodeJobSecretResponseDto {
  @ApiProperty({
    description:
      'What KIND of credential this is — the broker’s own key, e.g. `postgres.readonly`. ' +
      'A node uses it to decide how to interpret `material`; it is not a scope the node ' +
      'requested, it is the one the job’s type declares.',
  })
  kind!: string;

  @ApiProperty({
    description:
      'ISO 8601 timestamp the credential stops working. Bounded by this job’s LEASE — the ' +
      'server does not mint a second clock — so a node that keeps renewing its lease may ask ' +
      'again and get the same grant extended. Once the lease is gone, so is this.',
  })
  expiresAt!: string;

  @ApiProperty({
    description:
      'The credential itself. Its shape is the broker’s business (a DSN, a token and an ' +
      'endpoint, …) and this API passes it through without interpreting it. ⚠ RETURNED ONCE: ' +
      'hold it in memory for the life of this job and nowhere else — do not write it to disk, ' +
      'do not put it in an env var, do not log it, do not pass it to a child process that ' +
      'outlives the job. It is revoked when the job settles.',
    type: Object,
    additionalProperties: true,
  })
  material!: Record<string, unknown>;
}

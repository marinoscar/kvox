// =============================================================================
// Graph write errors (#355, epic #344; docs/specs/ontology.md §3.3, §8)
// =============================================================================
//
// `GraphWriteService` runs inside a CALLER'S transaction and is called from
// HTTP handlers and job handlers alike, so it throws domain errors rather than
// HTTP exceptions. `toGraphHttpException` is the one mapping to the wire:
//
//   - `GraphValidationError`  → 400, `details` passed through (`issues`,
//     `invalidEvidence`, …) so a client can name the problem.
//   - `GraphInvariantError`   → 400. `evidence_required` and `last_evidence`
//     are requests invalid in themselves — deliberately NOT a 409 reason; the
//     graph's 409 reasons stay a closed set (`GRAPH_CONFLICT_REASONS`).
//   - `GraphDuplicateError`   → 400 here; the proposal commit (#366) catches it
//     before this mapper and attaches evidence instead ("known, skipped").
//   - The database backstop's SQLSTATE `23514` (`kg no-orphans invariant`) →
//     500, logged at `error`. It is a BUG IN A WRITER, never a user error: the
//     service validates first, so reaching the trigger means something wrote a
//     curated row without going through `GraphWriteService`'s checks.
// =============================================================================

import {
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  type LoggerService,
} from '@nestjs/common';

/** A write refused on its own terms: bad type, props, endpoints, evidence anchors. */
export class GraphValidationError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'GraphValidationError';
  }
}

export type GraphInvariantCode = 'evidence_required' | 'last_evidence';

const INVARIANT_MESSAGES: Record<GraphInvariantCode, string> = {
  evidence_required: 'An accepted fact needs at least one citation.',
  last_evidence: 'An accepted fact must keep at least one citation.',
};

/** The no-orphans invariant (§3.3), caught by the service before any SQL. */
export class GraphInvariantError extends Error {
  constructor(readonly code: GraphInvariantCode) {
    super(INVARIANT_MESSAGES[code]);
    this.name = 'GraphInvariantError';
  }
}

/** A live item with the same `(owner, kind, subject, statement_hash)` exists. */
export class GraphDuplicateError extends Error {
  /**
   * `existingId` is the live row found by the pre-insert check, so the
   * proposal commit (#366) can attach its evidence there. It is absent only
   * when the race the pre-check cannot close tripped the unique index itself.
   */
  constructor(
    readonly statementHash: string,
    readonly existingId?: string,
  ) {
    super('This statement is already in your graph.');
    this.name = 'GraphDuplicateError';
  }
}

/** The SQLSTATE the deferred trigger raises. */
export const KG_INVARIANT_SQLSTATE = '23514';
const KG_INVARIANT_MARKER = 'kg no-orphans invariant';

/**
 * Whether `err` is the deferred trigger's refusal at COMMIT. Prisma (through
 * the pg driver adapter) does not surface one stable shape for a raised
 * exception, so the check reads every place the SQLSTATE or the trigger's own
 * message can land — and the marker is specific enough that no other error in
 * this application carries it.
 */
export function isKgInvariantViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    code?: unknown;
    message?: unknown;
    meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } };
    cause?: { originalCode?: unknown; originalMessage?: unknown; code?: unknown };
  };
  const message = typeof e.message === 'string' ? e.message : '';
  if (message.includes(KG_INVARIANT_MARKER)) return true;
  const adapterCause = e.meta?.driverAdapterError?.cause ?? e.cause;
  if (typeof adapterCause?.originalMessage === 'string' && adapterCause.originalMessage.includes(KG_INVARIANT_MARKER)) {
    return true;
  }
  return false;
}

/**
 * Map a graph write error to its HTTP exception, or return `null` when `err`
 * is none of ours (the caller rethrows it unchanged).
 */
export function toGraphHttpException(err: unknown, logger?: Pick<LoggerService, 'error'>): HttpException | null {
  if (err instanceof HttpException) return err;
  if (err instanceof GraphValidationError) {
    return new BadRequestException({ message: err.message, details: err.details });
  }
  if (err instanceof GraphInvariantError) {
    return new BadRequestException({ message: err.message, details: { reason: err.code } });
  }
  if (err instanceof GraphDuplicateError) {
    return new BadRequestException({ message: err.message, details: { statementHash: err.statementHash } });
  }
  if (isKgInvariantViolation(err)) {
    // Kind and id only — never content. This is a writer bug and should page.
    const text = err instanceof Error ? err.message : String(err);
    const match = /kg no-orphans invariant: (\w+) ([0-9a-f-]{36})/i.exec(text);
    logger?.error(
      `kg no-orphans invariant violated${match ? ` (${match[1]} ${match[2]})` : ''}`,
    );
    return new InternalServerErrorException('An internal error occurred while saving your graph.');
  }
  return null;
}

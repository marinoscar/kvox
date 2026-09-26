// =============================================================================
// Bounded graph queries (#370; docs/specs/ontology.md §9.1)
// =============================================================================
//
// The neighbourhood, expand and timeline reads run inside a transaction with
// `SET LOCAL statement_timeout = '3s'`: a walk over a pathological hub must
// fail fast rather than hold a pooled connection. A timeout is a 503 with
// `details.reason: 'graph_query_timeout'` and a warning in the log — never a
// 500, because nothing is broken; the question was too big.
// =============================================================================

import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';

export const GRAPH_STATEMENT_TIMEOUT_MS = 3000;
export const GRAPH_QUERY_TIMEOUT_REASON = 'graph_query_timeout';

type TxRunner = Pick<PrismaClient, '$transaction'>;

/** SQLSTATE 57014 (`query_canceled`) or Prisma's interactive-transaction timeout, however wrapped. */
export function isStatementTimeout(err: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): boolean => {
    if (value === null || value === undefined || depth > 5 || seen.has(value)) return false;
    if (typeof value === 'string') return value === '57014' || /statement timeout|canceling statement/i.test(value);
    if (typeof value !== 'object') return false;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (record.code === 'P2028') return true;
    for (const key of ['code', 'originalCode', 'message', 'meta', 'cause', 'driverAdapterError', 'kind']) {
      if (key in record && visit(record[key], depth + 1)) return true;
    }
    return false;
  };
  return visit(err, 0);
}

export async function withGraphStatementTimeout<T>(
  prisma: TxRunner,
  logger: Logger,
  context: Record<string, unknown>,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${GRAPH_STATEMENT_TIMEOUT_MS}ms'`);
        return fn(tx);
      },
      { timeout: GRAPH_STATEMENT_TIMEOUT_MS * 3, maxWait: 5000 },
    );
  } catch (err) {
    if (isStatementTimeout(err)) {
      // Ids and counts only — never a label or a quote.
      logger.warn({ msg: 'graph query timed out', ...context });
      throw new ServiceUnavailableException({
        message: 'This part of your graph took too long to read. Try fewer hops or a smaller limit.',
        details: { reason: GRAPH_QUERY_TIMEOUT_REASON },
      });
    }
    throw err;
  }
}

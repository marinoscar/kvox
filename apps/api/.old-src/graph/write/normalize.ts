// =============================================================================
// Alias and statement normalization (#355, epic #344; docs/specs/ontology.md §7)
// =============================================================================
//
// THE ONE DEFINITION of how a name or a statement is compared. `kg_entity_
// aliases.normalized` is produced by `normalizeAlias()` and by nothing else;
// `kg_items.statement_hash` is produced by `statementHash()` and by nothing
// else. Extraction (#363), resolution (#364) and every writer import these and
// never reimplement them — two normalizers that disagree about one character
// would make an exact-match lookup silently miss, and a dedup index silently
// admit a duplicate.
//
// PURE: no Prisma, no Nest, no clock. Locale-independent: `toLowerCase()`, not
// `toLocaleLowerCase()`, so a Turkish-locale process folds `I` the same way
// every other process does.
// =============================================================================

import { createHash } from 'node:crypto';

import type { KgItemKind } from '@app/shared/ontology';

import { GraphValidationError } from './graph-write.errors';

/** Leading/trailing punctuation, symbols and whitespace. */
const EDGE_PUNCTUATION = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu;
/** A run of two or more punctuation/symbol characters. */
const PUNCTUATION_RUN = /([\p{P}\p{S}])[\p{P}\p{S}]+/gu;
const WHITESPACE_RUN = /\s+/gu;

function baseNormalize(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(WHITESPACE_RUN, ' ')
    .replace(EDGE_PUNCTUATION, '')
    .trim();
}

function requireNonEmpty(value: string, field: 'alias' | 'statement'): string {
  if (value.length === 0) {
    throw new GraphValidationError(`The ${field} is empty once normalized.`, {
      issues: [{ path: field, message: `must contain at least one letter or digit` }],
    });
  }
  return value;
}

/**
 * The comparison form of a name: NFKC, lowercase, whitespace collapsed to one
 * space, leading/trailing punctuation and symbols stripped, trimmed.
 *
 * Throws `GraphValidationError` when nothing is left (`''` is never a valid
 * normalized alias — it would match every other empty alias).
 */
export function normalizeAlias(input: string): string {
  return requireNonEmpty(baseNormalize(String(input ?? '')), 'alias');
}

/**
 * The comparison form of a statement: `normalizeAlias`'s rules, plus every
 * internal run of punctuation collapsed to its first character, so
 * `"Ship it!!"` and `"ship it!"` are the same statement.
 */
export function normalizeStatement(input: string): string {
  const base = baseNormalize(String(input ?? ''))
    .replace(PUNCTUATION_RUN, '$1')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
  return requireNonEmpty(base, 'statement');
}

/**
 * The §7 dedup/suppression key: sha256 hex of `${kind}\n${normalizeStatement}`.
 *
 * The SUBJECT IS DELIBERATELY EXCLUDED so extraction (#363) can hash before
 * resolution has assigned a subject id. Uniqueness still keys on `subject_id`
 * — `kg_items_live_statement_uniq_idx` includes it.
 */
export function statementHash(kind: KgItemKind, statement: string): string {
  return createHash('sha256').update(`${kind}\n${normalizeStatement(statement)}`, 'utf8').digest('hex');
}

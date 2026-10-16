// The Prisma enum value lists the graph wire schemas build a Zod enum from,
// as plain tuples. The contract cannot import `@prisma/client`, so the
// compile-time parity checks (`satisfies readonly KgAliasSource[]` and its
// exhaustiveness twin) stay in the API, in `apps/api/src/graph/dto/graph-enums.ts`,
// and a spec (`apps/api/test/contract/prisma-enum-parity.spec.ts`) asserts the
// runtime equality with `Object.values(<PrismaEnum>)`.

/**
 * Mirrors the `KgAliasSource` Prisma enum.
 *
 * @stability experimental
 */
export const KG_ALIAS_SOURCES_FOR_DTO = ['user', 'extraction', 'speaker_naming', 'import'] as const;

/**
 * Mirrors the `KgReviewStatus` Prisma enum.
 *
 * @stability experimental
 */
export const KG_REVIEW_STATUSES_FOR_DTO = [
  'unreviewed',
  'accepted',
  'edited',
  'rejected',
  'merged',
  'superseded',
] as const;

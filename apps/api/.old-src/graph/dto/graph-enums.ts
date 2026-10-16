// The Prisma enum value lists, as tuples Zod can build an enum from. Kept in
// one file so a DTO never hand-copies an enum's members. The `satisfies`
// clauses fail the build if Prisma's enum gains or loses a member.

import type { KgAliasSource, KgReviewStatus } from '@prisma/client';

export const KG_ALIAS_SOURCES_FOR_DTO = ['user', 'extraction', 'speaker_naming', 'import'] as const satisfies readonly KgAliasSource[];

export const KG_REVIEW_STATUSES_FOR_DTO = [
  'unreviewed',
  'accepted',
  'edited',
  'rejected',
  'merged',
  'superseded',
] as const satisfies readonly KgReviewStatus[];

// Exhaustiveness in the other direction: every Prisma member is listed.
type Missing<A extends string, B extends readonly string[]> = Exclude<A, B[number]>;
const _aliasExhaustive: Missing<KgAliasSource, typeof KG_ALIAS_SOURCES_FOR_DTO> extends never ? true : never = true;
const _reviewExhaustive: Missing<KgReviewStatus, typeof KG_REVIEW_STATUSES_FOR_DTO> extends never ? true : never = true;
void _aliasExhaustive;
void _reviewExhaustive;

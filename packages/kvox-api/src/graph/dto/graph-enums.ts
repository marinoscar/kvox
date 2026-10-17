// The Prisma enum value lists, as tuples Zod can build an enum from. The tuples
// live in `@marinoscar/kvox-contract/graph` (issue #488: the contract cannot
// import `@prisma/client`); this file keeps the parity checks. The
// `satisfies`-style assignments below fail the build if Prisma's enum gains or
// loses a member.

import { KG_ALIAS_SOURCES_FOR_DTO, KG_REVIEW_STATUSES_FOR_DTO } from '@marinoscar/kvox-contract/graph';
import type { KgAliasSourceValue as KgAliasSource, KgReviewStatusValue as KgReviewStatus } from '../data/graph-db.js';

export { KG_ALIAS_SOURCES_FOR_DTO, KG_REVIEW_STATUSES_FOR_DTO };

const _aliasMembers: readonly KgAliasSource[] = KG_ALIAS_SOURCES_FOR_DTO;
const _reviewMembers: readonly KgReviewStatus[] = KG_REVIEW_STATUSES_FOR_DTO;
void _aliasMembers;
void _reviewMembers;

// Exhaustiveness in the other direction: every Prisma member is listed.
type Missing<A extends string, B extends readonly string[]> = Exclude<A, B[number]>;
const _aliasExhaustive: Missing<KgAliasSource, typeof KG_ALIAS_SOURCES_FOR_DTO> extends never ? true : never = true;
const _reviewExhaustive: Missing<KgReviewStatus, typeof KG_REVIEW_STATUSES_FOR_DTO> extends never ? true : never = true;
void _aliasExhaustive;
void _reviewExhaustive;

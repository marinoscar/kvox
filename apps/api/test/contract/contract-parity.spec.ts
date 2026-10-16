import { AskErrorClass, AskFinishReason, KgAliasSource, KgReviewStatus } from '@prisma/client';

import { ASK_ERROR_CLASSES, ASK_FINISH_REASONS } from '@marinoscar/kvox-contract/ask';
import { KG_ALIAS_SOURCES_FOR_DTO, KG_REVIEW_STATUSES_FOR_DTO } from '@marinoscar/kvox-contract/graph';

// =============================================================================
// The wire schemas moved to `@marinoscar/kvox-contract` (issue #488), which
// cannot import `@prisma/client`. Where a schema mirrors a Prisma enum it holds
// a string-literal tuple; this suite pins that each tuple equals
// `Object.values(<PrismaEnum>)`, so a migration that adds a member fails here
// rather than at a client.
// =============================================================================

describe('contract tuples mirror the Prisma enums', () => {
  it.each([
    ['ASK_ERROR_CLASSES', ASK_ERROR_CLASSES, AskErrorClass],
    ['ASK_FINISH_REASONS', ASK_FINISH_REASONS, AskFinishReason],
    ['KG_ALIAS_SOURCES_FOR_DTO', KG_ALIAS_SOURCES_FOR_DTO, KgAliasSource],
    ['KG_REVIEW_STATUSES_FOR_DTO', KG_REVIEW_STATUSES_FOR_DTO, KgReviewStatus],
  ] as const)('%s lists exactly the members of its enum', (_name, tuple, prismaEnum) => {
    expect([...tuple].sort()).toEqual(Object.values(prismaEnum).sort());
  });
});

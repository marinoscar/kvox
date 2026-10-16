import { createZodDto } from 'nestjs-zod';
import { entityBriefResponseSchema } from '@marinoscar/kvox-contract/graph';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/graph` (issue #488, file `graph/entity-brief.ts`); they are re-exported below so no importer changes.
export {
  BRIEF_SECTION_LIMITS,
  BRIEF_RELATED_LIMIT,
  BRIEF_ENTRY_EVIDENCE_IDS,
  DIGEST_STATEMENT_EVIDENCE_IDS,
  entityBriefQuerySchema,
  type EntityBriefQuery,
  citedStatementSchema,
  type CitedStatement,
  briefEntityRefSchema,
  type BriefEntityRef,
  briefEntrySchema,
  type BriefEntry,
  peopleChangeSchema,
  type PeopleChange,
  relatedSourceSchema,
  type RelatedSource,
  DIGEST_UNAVAILABLE_REASONS,
  type DigestUnavailableReason,
  entityBriefResponseSchema,
  type EntityBriefResponse,
  type BriefSections,
} from '@marinoscar/kvox-contract/graph';

export class EntityBriefResponseDto extends createZodDto(entityBriefResponseSchema) {}

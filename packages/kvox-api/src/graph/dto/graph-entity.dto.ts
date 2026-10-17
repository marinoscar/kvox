import { createZodDto } from 'nestjs-zod';
import { patchEntitySchema, graphEntitySchema } from '@marinoscar/kvox-contract/graph';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/graph` (issue #488, file `graph/graph-entity.ts`); they are re-exported below so no importer changes.
export {
  patchEntitySchema,
  type PatchEntityDto,
  graphEntityAliasSchema,
  graphEntitySchema,
  type GraphEntityResponse,
} from '@marinoscar/kvox-contract/graph';

export class PatchEntityBodyDto extends createZodDto(patchEntitySchema) {}
export class GraphEntityDto extends createZodDto(graphEntitySchema) {}

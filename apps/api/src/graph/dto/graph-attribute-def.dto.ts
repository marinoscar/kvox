import { createZodDto } from 'nestjs-zod';
import {
  createAttributeDefSchema,
  patchAttributeDefSchema,
  graphAttributeDefSchema,
  graphAttributeDefListSchema,
} from '@marinoscar/kvox-contract/graph';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/graph` (issue #488, file `graph/graph-attribute-def.ts`); they are re-exported below so no importer changes.
export {
  attributeDefOptionsSchema,
  createAttributeDefSchema,
  type CreateAttributeDefDto,
  patchAttributeDefSchema,
  type PatchAttributeDefDto,
  attributeDefListQuerySchema,
  type AttributeDefListQuery,
  graphAttributeDefSchema,
  type GraphAttributeDefResponse,
  graphAttributeDefListSchema,
} from '@marinoscar/kvox-contract/graph';

export class CreateAttributeDefBodyDto extends createZodDto(createAttributeDefSchema) {}
export class PatchAttributeDefBodyDto extends createZodDto(patchAttributeDefSchema) {}
export class GraphAttributeDefDto extends createZodDto(graphAttributeDefSchema) {}
export class GraphAttributeDefListDto extends createZodDto(graphAttributeDefListSchema) {}

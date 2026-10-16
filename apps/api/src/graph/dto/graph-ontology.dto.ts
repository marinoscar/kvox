import { createZodDto } from 'nestjs-zod';
import { graphOntologyResponseSchema } from '@marinoscar/kvox-contract/graph';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/graph` (issue #488, file `graph/graph-ontology.ts`); they are re-exported below so no importer changes.
export {
  graphOntologyAttributeSchema,
  graphOntologyDomainSchema,
  graphOntologyEntityTypeSchema,
  graphOntologyRelationTypeSchema,
  graphOntologyResponseSchema,
  type GraphOntologyResponse,
} from '@marinoscar/kvox-contract/graph';

export class GraphOntologyDto extends createZodDto(graphOntologyResponseSchema) {}

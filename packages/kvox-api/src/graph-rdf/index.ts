// The graph-rdf slice of @marinoscar/kvox-api (issue #496, epic #491).
//
// Depends on `ports`, `core`, `graph` and `graph-extraction`. The one way in is
// `GraphRdfModule.forRoot(options)`. This is the ONLY slice that needs the optional peers
// `n3`, `jsonld` and `rdf-validate-shacl`. The classes are internal wiring (tagged
// `@internal`): a host configures them through `forRoot` and never instantiates them.

export { GraphRdfModule } from './graph-rdf.module.js';
export {
  GRAPH_RDF_OPTIONS,
  resolveGraphRdfOptions,
  type GraphRdfModuleOptions,
  type ResolvedGraphRdfOptions,
} from './graph-rdf.options.js';

// Ontology artefacts.
export { GraphRdfService } from './rdf/graph-rdf.service.js';
export { GraphRdfController } from './rdf/graph-rdf.controller.js';

// Export.
export { GraphExportService, KG_EXPORT_TTL_DAYS } from './export/graph-export.service.js';
export { GraphExportSource } from './export/graph-export.source.js';
export { GraphExportController } from './export/graph-export.controller.js';
export { KgExportHandler } from './export/kg-export.handler.js';
export { KgExportExpiryEnqueuer } from './export/kg-export-expiry.enqueuer.js';

// Import.
export { GraphImportService } from './import/graph-import.service.js';
export { GraphImportController } from './import/graph-import.controller.js';
export { KgImportHandler } from './import/kg-import.handler.js';
export {
  GRAPH_IMPORT_MAX_BYTES,
  GRAPH_IMPORT_MAX_TRIPLES,
  graphImportStorageKey,
} from './import/graph-import.constants.js';
export { assertShaclEngineResolvable } from './import/shacl-engine.js';

export type { ShaclEngine } from './import/shacl-engine.js';
export type { ShaclEngineReport } from './import/shacl-engine.js';
export type { ImportQuad } from './import/import-dataset.js';
export type { ImportTerm } from './import/import-dataset.js';
export type { ShaclResultRecord } from './import/shacl-engine.js';
export type { ImportTermType } from './import/import-dataset.js';

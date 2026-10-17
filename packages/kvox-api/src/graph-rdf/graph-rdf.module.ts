import { Module, type DynamicModule, type Provider, type Type } from '@nestjs/common';

import { documentKvoxAuth } from '../core/index.js';
import { GraphExtractionModule } from '../graph-extraction/index.js';
import { GraphModule } from '../graph/index.js';
import { NotesModule } from '../notes/index.js';
import { TranscriptsModule } from '../transcripts/index.js';
import { GraphExportController } from './export/graph-export.controller.js';
import { GraphExportService } from './export/graph-export.service.js';
import { GraphExportSource } from './export/graph-export.source.js';
import { KgExportExpiryEnqueuer } from './export/kg-export-expiry.enqueuer.js';
import { KgExportHandler } from './export/kg-export.handler.js';
import {
  GRAPH_RDF_OPTIONS,
  resolveGraphRdfOptions,
  type GraphRdfModuleOptions,
} from './graph-rdf.options.js';
import { GraphImportController } from './import/graph-import.controller.js';
import { GraphImportService } from './import/graph-import.service.js';
import { KgImportHandler } from './import/kg-import.handler.js';
import { assertShaclEngineResolvable } from './import/shacl-engine.js';
import { GraphRdfController } from './rdf/graph-rdf.controller.js';
import { GraphRdfService } from './rdf/graph-rdf.service.js';

// =============================================================================
// GraphRdfModule (#385 to #387, epic #346; the package slice of issue #496, epic #491)
// =============================================================================
//
// The graph as a standard: the generated OWL/RDFS and SHACL artefacts (`ontology.ttl`,
// `shapes.ttl`), RDF data export (JSON-LD, Turtle, N-Quads: `kg.export` and its expiry
// sweep) and RDF import (`kg.import`: a file in, a draft proposal out, never a direct write).
//
// It is the ONLY slice that needs `n3`, `jsonld` and `rdf-validate-shacl` (optional peers of
// the package), and only three files import them: `import/rdf-parse.ts`,
// `import/shacl-engine.ts` and `export/serializers.ts`. A host that does not mount RDF never
// installs them.
//
// ⚠ `rdf-validate-shacl` IS ESM-ONLY, and this package is CommonJS. The import job validates
// in a CHILD `node` process running the package's plain CommonJS script
// `runners/shacl-runner.cjs`, or, when the host passes `shacl.run` (a binary that cannot run
// Node, such as Desktop's Electron), through the host, which runs the same script's
// `runShaclValidation` (`@marinoscar/kvox-api/graph-rdf/shacl-runner`) in an isolated process.
// Either way the engine is located with `require.resolve` from this package's own place on
// disk, which is why the HOST must install it. The module checks that when the import is
// switched on, and refuses to start naming the missing peer.
//
// RDF IRIs include the application slug (`KVOX_BRAND.appSlug`): a different slug changes
// every IRI. A host whose graphs travel between editions passes the same slug.
// =============================================================================

/**
 * The RDF slice: ontology artefacts, graph export and graph import.
 *
 * @stability experimental
 */
@Module({})
export class GraphRdfModule {
  /**
   * Builds the module over the host's ports.
   *
   * @param options - which halves to mount, the import size ceiling, schedules and the peer modules.
   * @returns the dynamic module.
   * @throws Error when the import is on and the optional peer `rdf-validate-shacl` cannot be resolved.
   */
  static forRoot(options: GraphRdfModuleOptions = {}): DynamicModule {
    const resolved = resolveGraphRdfOptions(options);

    // Fail at boot, naming the peer, rather than on the first import.
    if (resolved.import) assertShaclEngineResolvable();

    // The ontology artefacts are always served; the halves are optional.
    const controllers: Type<unknown>[] = [GraphRdfController];
    const providers: Provider[] = [{ provide: GRAPH_RDF_OPTIONS, useValue: resolved }, GraphRdfService];

    if (resolved.export) {
      controllers.push(GraphExportController);
      providers.push(GraphExportSource, GraphExportService, KgExportHandler, KgExportExpiryEnqueuer);

      if (resolved.schedules) {
        const { KgExportExpiryTask } =
          require('./export/kg-export-expiry.task.js') as typeof import('./export/kg-export-expiry.task.js');
        providers.push(KgExportExpiryTask);
      }
    }

    if (resolved.import) {
      controllers.push(GraphImportController);
      providers.push(GraphImportService, KgImportHandler);
    }

    // Now that the routes are known, describe them in the API document the way the host chose.
    documentKvoxAuth(controllers);

    return {
      module: GraphRdfModule,
      global: false,
      imports: [
        ...(options.imports ?? []),
        // The peer slices. The application imports each itself; pass the very same objects
        // here (a dynamic module built twice with the same options is one module, but a
        // different configuration would register a handler twice).
        options.peers?.graph ?? GraphModule.forRoot(),
        options.peers?.extraction ?? GraphExtractionModule.forRoot(),
        options.peers?.transcripts ?? TranscriptsModule.forRoot(),
        options.peers?.notes ?? NotesModule.forRoot(),
      ],
      controllers,
      providers,
      exports: [GRAPH_RDF_OPTIONS, GraphRdfService],
    };
  }
}
